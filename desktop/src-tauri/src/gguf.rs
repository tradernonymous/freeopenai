// A GGUF file's header, read before the model is ever loaded.
//
// llama-server only says how long a model's context is (/v1/models) once it
// has loaded it -- so the FIRST load of a file used guesses, and a guess that
// is too big allocates gigabytes of KV cache the machine does not have. The
// header already knows: the trained context, the layer count and the
// attention shape the cache is sized from. This reads that and nothing else.
//
// The header is a list of key/value pairs in front of the tensor data. Most of
// it is tokenizer arrays (a vocabulary of 150k strings, the merges), which are
// SKIPPED: their lengths are read and the bytes stepped over through a fixed
// scratch buffer or a seek -- never allocated. Only a handful of keys are
// kept. Every read is capped: at most MAX_KV pairs, MAX_READ bytes in all,
// MAX_KEEP_STR for a string that is kept, so a damaged or hostile file costs
// a bounded amount of work and memory. Read-only: the file is never written.
//
// Split sets (…-00002-of-00003.gguf): part 1 carries the metadata, so a later
// part is read as its part 1 when that file is beside it.
use std::fs::File;
use std::io::{BufReader, ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// "GGUF" as a little-endian u32.
const MAGIC: u32 = 0x4655_4747;
/// More pairs than any real model has; past it the file is not trusted.
const MAX_KV: u64 = 100_000;
/// A key is a short dotted name.
const MAX_KEY: u64 = 64 * 1024;
/// The longest string value that is kept (a name, a size label, the chat
/// template -- the largest real template is a few tens of kilobytes).
const MAX_KEEP_STR: u64 = 1024 * 1024;
/// Never read further into a file than this, header or not.
const MAX_READ: u64 = 64 * 1024 * 1024;
/// Arrays of arrays exist in the format; deeper than this is not a model.
const MAX_DEPTH: u32 = 4;
/// Skips up to this size go through the scratch buffer; longer ones seek.
const SCRATCH: usize = 8 * 1024;

/// The keys under `<architecture>.` that are kept.
const ARCH_KEYS: [&str; 8] = [
    ".context_length",
    ".block_count",
    ".embedding_length",
    ".attention.head_count",
    ".attention.head_count_kv",
    ".attention.key_length",
    ".attention.value_length",
    ".attention.sliding_window",
];

/// What the header says about the model. Numbers the file does not carry are None.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct GgufInfo {
    pub version: u32,
    pub architecture: String,
    pub name: Option<String>,
    pub size_label: Option<String>,
    pub file_type: Option<u64>,
    pub context_length: Option<u64>,
    pub block_count: Option<u64>,
    pub embedding_length: Option<u64>,
    pub head_count: Option<u64>,
    /// Per-layer on some models (an array): the largest.
    pub head_count_kv: Option<u64>,
    pub key_length: Option<u64>,
    pub value_length: Option<u64>,
    pub sliding_window: Option<u64>,
    /// The model's own Jinja chat template, verbatim. The page renders it so a
    /// prompt is shaped the way this model was trained, instead of generically.
    /// Untrusted text from a downloaded file: it is carried, never trusted.
    pub chat_template: Option<String>,
    /// False when the header could not be read to its end (a cap was hit or
    /// the file is cut short) but the architecture had already been found.
    pub complete: bool,
}

enum Val {
    Num(u64),
    Str(String),
    Other,
}

fn io_err(e: std::io::Error) -> String {
    if e.kind() == ErrorKind::UnexpectedEof {
        "the file ends inside its header (cut short, or not a GGUF)".to_string()
    } else {
        format!("could not read the file: {}", e)
    }
}

fn scalar_size(ty: u32) -> Option<u64> {
    match ty {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    }
}

fn non_negative(v: i64) -> Option<u64> {
    if v >= 0 {
        Some(v as u64)
    } else {
        None
    }
}

fn wanted(key: &str) -> bool {
    if key.len() > 256 {
        return false;
    }
    matches!(
        key,
        "general.architecture"
            | "general.name"
            | "general.size_label"
            | "general.file_type"
            | "tokenizer.chat_template"
    ) || ARCH_KEYS.iter().any(|suffix| key.ends_with(suffix))
}

/// A reader that counts what it has consumed and refuses to pass MAX_READ.
struct Src<R> {
    r: R,
    pos: u64,
    scratch: [u8; SCRATCH],
}

impl<R: Read + Seek> Src<R> {
    fn advance(&mut self, n: u64) -> Result<(), String> {
        let next = self
            .pos
            .checked_add(n)
            .ok_or_else(|| "a length in the header is impossibly large".to_string())?;
        if next > MAX_READ {
            return Err(format!(
                "the header runs past {} MB; not reading further",
                MAX_READ / (1024 * 1024)
            ));
        }
        self.pos = next;
        Ok(())
    }

    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        self.advance(N as u64)?;
        let mut buf = [0u8; N];
        self.r.read_exact(&mut buf).map_err(io_err)?;
        Ok(buf)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.bytes::<1>()?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }

    /// Step over `n` bytes without keeping them: no allocation either way.
    fn skip(&mut self, n: u64) -> Result<(), String> {
        self.advance(n)?;
        if n <= SCRATCH as u64 {
            let len = n as usize;
            self.r.read_exact(&mut self.scratch[..len]).map_err(io_err)
        } else {
            // n <= MAX_READ, so it fits an i64.
            self.r
                .seek(SeekFrom::Current(n as i64))
                .map(|_| ())
                .map_err(io_err)
        }
    }

    /// Bytes that are kept (a key, or a string value within MAX_KEEP_STR).
    fn take(&mut self, n: u64) -> Result<Vec<u8>, String> {
        self.advance(n)?;
        let mut buf = vec![0u8; n as usize];
        self.r.read_exact(&mut buf).map_err(io_err)?;
        Ok(buf)
    }

    /// One number of type `ty`, as a u64 when it is a non-negative integer.
    fn num(&mut self, ty: u32) -> Result<Option<u64>, String> {
        Ok(match ty {
            0 | 7 => Some(self.u8()? as u64),
            1 => non_negative(self.u8()? as i8 as i64),
            2 => Some(u16::from_le_bytes(self.bytes::<2>()?) as u64),
            3 => non_negative(i16::from_le_bytes(self.bytes::<2>()?) as i64),
            4 => Some(self.u32()? as u64),
            5 => non_negative(i32::from_le_bytes(self.bytes::<4>()?) as i64),
            10 => Some(self.u64()?),
            11 => non_negative(i64::from_le_bytes(self.bytes::<8>()?)),
            6 => {
                self.skip(4)?;
                None
            }
            12 => {
                self.skip(8)?;
                None
            }
            other => return Err(format!("unknown value type {} in the header", other)),
        })
    }

    /// One value of type `ty`. Kept only when `want`; otherwise stepped over.
    fn value(&mut self, ty: u32, want: bool, depth: u32) -> Result<Val, String> {
        match ty {
            8 => {
                let len = self.u64()?;
                if want && len <= MAX_KEEP_STR {
                    let bytes = self.take(len)?;
                    Ok(Val::Str(String::from_utf8_lossy(&bytes).into_owned()))
                } else {
                    self.skip(len)?;
                    Ok(Val::Other)
                }
            }
            9 => {
                if depth >= MAX_DEPTH {
                    return Err("arrays nested too deeply in the header".to_string());
                }
                let elem = self.u32()?;
                let count = self.u64()?;
                match scalar_size(elem) {
                    // A wanted per-layer number (head_count_kv on some
                    // models): keep the largest, allocate nothing.
                    Some(_) if want => {
                        let mut max: Option<u64> = None;
                        for _ in 0..count {
                            if let Some(v) = self.num(elem)? {
                                max = Some(max.map_or(v, |m| m.max(v)));
                            }
                        }
                        Ok(max.map_or(Val::Other, Val::Num))
                    }
                    // Fixed-size elements: one skip for the lot.
                    Some(size) => {
                        let total = count
                            .checked_mul(size)
                            .ok_or_else(|| "an array in the header is impossibly large".to_string())?;
                        self.skip(total)?;
                        Ok(Val::Other)
                    }
                    // Strings (the vocabulary) or nested arrays: each one's
                    // length is read and its bytes skipped. Every element
                    // consumes at least 8 bytes, so MAX_READ bounds the loop.
                    None => {
                        for _ in 0..count {
                            self.value(elem, false, depth + 1)?;
                        }
                        Ok(Val::Other)
                    }
                }
            }
            _ => Ok(self.num(ty)?.map_or(Val::Other, Val::Num)),
        }
    }
}

fn read_pairs<R: Read + Seek>(
    src: &mut Src<R>,
    count: u64,
    info: &mut GgufInfo,
    found: &mut Vec<(String, u64)>,
) -> Result<(), String> {
    for _ in 0..count {
        let key_len = src.u64()?;
        if key_len > MAX_KEY {
            return Err("a key in the header is too long; not a model file".to_string());
        }
        let key = String::from_utf8_lossy(&src.take(key_len)?).into_owned();
        let ty = src.u32()?;
        let want = wanted(&key);
        match src.value(ty, want, 0)? {
            Val::Str(s) => match key.as_str() {
                "general.architecture" => info.architecture = s,
                "general.name" => info.name = Some(s),
                "general.size_label" => info.size_label = Some(s),
                "tokenizer.chat_template" => info.chat_template = Some(s),
                _ => {}
            },
            Val::Num(n) => {
                if key == "general.file_type" {
                    info.file_type = Some(n);
                } else if want {
                    found.push((key, n));
                }
            }
            Val::Other => {}
        }
    }
    Ok(())
}

/// Parse a GGUF header from any seekable reader (a file, or bytes in a test).
pub fn parse<R: Read + Seek>(reader: R) -> Result<GgufInfo, String> {
    let mut src = Src {
        r: reader,
        pos: 0,
        scratch: [0u8; SCRATCH],
    };
    if src.u32()? != MAGIC {
        return Err("not a GGUF file".to_string());
    }
    let version = src.u32()?;
    if !(2..=3).contains(&version) {
        return Err(format!("GGUF version {} is not supported (2 and 3 are)", version));
    }
    let _tensor_count = src.u64()?;
    let kv_count = src.u64()?;
    if kv_count > MAX_KV {
        return Err(format!("the header claims {} entries; not a model file", kv_count));
    }

    let mut info = GgufInfo {
        version,
        complete: true,
        ..Default::default()
    };
    // `<arch>.<key>` numbers, matched to the architecture once it is known
    // (the format does not promise general.architecture comes first).
    let mut found: Vec<(String, u64)> = Vec::new();
    if let Err(e) = read_pairs(&mut src, kv_count, &mut info, &mut found) {
        if info.architecture.is_empty() {
            return Err(e);
        }
        info.complete = false;
    }
    if info.architecture.is_empty() {
        return Err("the header does not name the model's architecture".to_string());
    }

    let arch = info.architecture.clone();
    let get = |suffix: &str| -> Option<u64> {
        let full = format!("{}{}", arch, suffix);
        found.iter().find(|(k, _)| *k == full).map(|(_, v)| *v)
    };
    info.context_length = get(".context_length");
    info.block_count = get(".block_count");
    info.embedding_length = get(".embedding_length");
    info.head_count = get(".attention.head_count");
    info.head_count_kv = get(".attention.head_count_kv");
    info.key_length = get(".attention.key_length");
    info.value_length = get(".attention.value_length");
    info.sliding_window = get(".attention.sliding_window");
    Ok(info)
}

/// The file whose header describes the model: part 1 of a split set when
/// `path` is a later part and part 1 is beside it; otherwise `path` itself.
pub fn first_part(path: &Path) -> PathBuf {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return path.to_path_buf(),
    };
    if !name.to_ascii_lowercase().ends_with(".gguf") {
        return path.to_path_buf();
    }
    let stem = match name.get(..name.len() - 5) {
        Some(s) => s,
        None => return path.to_path_buf(),
    };
    // "-NNNNN-of-NNNNN" is 15 bytes.
    if stem.len() < 15 {
        return path.to_path_buf();
    }
    let (head, tail) = match (stem.get(..stem.len() - 15), stem.get(stem.len() - 15..)) {
        (Some(h), Some(t)) => (h, t),
        _ => return path.to_path_buf(),
    };
    let b = tail.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_digit());
    let shaped = b[0] == b'-' && digits(1..6) && &b[6..10] == b"-of-" && digits(10..15);
    if !shaped || &tail[1..6] == "00001" {
        return path.to_path_buf();
    }
    let first = path.with_file_name(format!("{}-00001{}{}", head, &tail[6..], &name[name.len() - 5..]));
    if first.is_file() {
        first
    } else {
        path.to_path_buf()
    }
}

/// Read the header of the GGUF at `path` (part 1 of a split set is used).
pub fn read_header(path: &Path) -> Result<GgufInfo, String> {
    let file = File::open(first_part(path)).map_err(|e| format!("could not open the file: {}", e))?;
    parse(BufReader::with_capacity(64 * 1024, file))
}

/// The model's facts from its header, before any load. Confined to an
/// existing .gguf file and read-only.
#[tauri::command(async)]
pub fn gguf_info(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(path.trim());
    let is_gguf = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("only a .gguf file can be read".to_string());
    }
    if !p.is_file() {
        return Err(format!("{} is not a file on this machine", path.trim()));
    }
    let info = read_header(p)?;
    serde_json::to_value(&info).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A GGUF header built in memory.
    struct Gguf {
        body: Vec<u8>,
        count: u64,
    }

    impl Gguf {
        fn new() -> Self {
            Gguf { body: Vec::new(), count: 0 }
        }
        fn key(&mut self, key: &str, ty: u32) {
            self.count += 1;
            self.body.extend_from_slice(&(key.len() as u64).to_le_bytes());
            self.body.extend_from_slice(key.as_bytes());
            self.body.extend_from_slice(&ty.to_le_bytes());
        }
        fn string(&mut self, key: &str, value: &str) -> &mut Self {
            self.key(key, 8);
            self.body.extend_from_slice(&(value.len() as u64).to_le_bytes());
            self.body.extend_from_slice(value.as_bytes());
            self
        }
        fn u32(&mut self, key: &str, value: u32) -> &mut Self {
            self.key(key, 4);
            self.body.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn u64(&mut self, key: &str, value: u64) -> &mut Self {
            self.key(key, 10);
            self.body.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn f32(&mut self, key: &str, value: f32) -> &mut Self {
            self.key(key, 6);
            self.body.extend_from_slice(&value.to_le_bytes());
            self
        }
        fn i32_array(&mut self, key: &str, values: &[i32]) -> &mut Self {
            self.key(key, 9);
            self.body.extend_from_slice(&5u32.to_le_bytes());
            self.body.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for v in values {
                self.body.extend_from_slice(&v.to_le_bytes());
            }
            self
        }
        fn string_array(&mut self, key: &str, values: &[&str]) -> &mut Self {
            self.key(key, 9);
            self.body.extend_from_slice(&8u32.to_le_bytes());
            self.body.extend_from_slice(&(values.len() as u64).to_le_bytes());
            for v in values {
                self.body.extend_from_slice(&(v.len() as u64).to_le_bytes());
                self.body.extend_from_slice(v.as_bytes());
            }
            self
        }
        /// An array header that claims `count` u8 elements, with no bytes behind it.
        fn huge_u8_array(&mut self, key: &str, count: u64) -> &mut Self {
            self.key(key, 9);
            self.body.extend_from_slice(&0u32.to_le_bytes());
            self.body.extend_from_slice(&count.to_le_bytes());
            self
        }
        fn bytes(&self, version: u32) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(b"GGUF");
            out.extend_from_slice(&version.to_le_bytes());
            out.extend_from_slice(&291u64.to_le_bytes());
            out.extend_from_slice(&self.count.to_le_bytes());
            out.extend_from_slice(&self.body);
            out
        }
    }

    fn llama() -> Gguf {
        let mut g = Gguf::new();
        g.string("general.architecture", "llama")
            .string("general.name", "Meta Llama 3 8B Instruct")
            .string("general.size_label", "8B")
            .u32("general.file_type", 15)
            .u32("llama.context_length", 8192)
            .u32("llama.block_count", 32)
            .u32("llama.embedding_length", 4096)
            .u32("llama.attention.head_count", 32)
            .u32("llama.attention.head_count_kv", 8)
            .f32("llama.rope.freq_base", 500000.0)
            .string_array("tokenizer.ggml.tokens", &["<s>", "</s>", "hello", "world"])
            .i32_array("tokenizer.ggml.token_type", &[3, 3, 1, 1]);
        g
    }

    #[test]
    fn reads_a_llama_header() {
        let info = parse(Cursor::new(llama().bytes(3))).unwrap();
        assert_eq!(info.version, 3);
        assert_eq!(info.architecture, "llama");
        assert_eq!(info.name.as_deref(), Some("Meta Llama 3 8B Instruct"));
        assert_eq!(info.size_label.as_deref(), Some("8B"));
        assert_eq!(info.file_type, Some(15));
        assert_eq!(info.context_length, Some(8192));
        assert_eq!(info.block_count, Some(32));
        assert_eq!(info.embedding_length, Some(4096));
        assert_eq!(info.head_count, Some(32));
        assert_eq!(info.head_count_kv, Some(8));
        assert_eq!(info.key_length, None);
        assert_eq!(info.sliding_window, None);
        assert!(info.complete);
    }

    #[test]
    fn the_chat_template_comes_out_whole() {
        let mut g = Gguf::new();
        let template = "{% for m in messages %}<|im_start|>{{ m['role'] }}
{{ m['content'] }}<|im_end|>
{% endfor %}";
        g.string("general.architecture", "qwen3")
            .string("tokenizer.chat_template", template)
            .string_array("tokenizer.ggml.tokens", &["<s>", "hello"]);
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.chat_template.as_deref(), Some(template));

        // A file with no template says so, rather than inventing one.
        let plain = parse(Cursor::new(llama().bytes(3))).unwrap();
        assert_eq!(plain.chat_template, None);
    }

    #[test]
    fn a_template_past_the_keep_cap_is_skipped() {
        let mut g = Gguf::new();
        let huge = "x".repeat((MAX_KEEP_STR + 1) as usize);
        g.string("general.architecture", "llama")
            .string("tokenizer.chat_template", &huge);
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.chat_template, None);
        assert!(info.complete);
    }

    #[test]
    fn version_2_reads_the_same() {
        let info = parse(Cursor::new(llama().bytes(2))).unwrap();
        assert_eq!(info.context_length, Some(8192));
    }

    #[test]
    fn architecture_keys_may_come_before_the_architecture() {
        let mut g = Gguf::new();
        g.u64("qwen3.context_length", 40960)
            .u32("qwen3.attention.key_length", 128)
            .u32("qwen3.attention.value_length", 128)
            .u32("other.context_length", 7)
            .string("general.architecture", "qwen3");
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.context_length, Some(40960));
        assert_eq!(info.key_length, Some(128));
        assert_eq!(info.value_length, Some(128));
    }

    #[test]
    fn per_layer_kv_heads_take_the_largest() {
        let mut g = Gguf::new();
        g.string("general.architecture", "gemma3")
            .i32_array("gemma3.attention.head_count_kv", &[4, 8, 0, 8, 2])
            .u32("gemma3.attention.sliding_window", 1024);
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.head_count_kv, Some(8));
        assert_eq!(info.sliding_window, Some(1024));
    }

    #[test]
    fn rejects_what_is_not_a_gguf() {
        assert!(parse(Cursor::new(b"PK\x03\x04 not a model".to_vec())).is_err());
        assert!(parse(Cursor::new(Vec::new())).is_err());
        // Version 1 used 32-bit lengths.
        assert!(parse(Cursor::new(llama().bytes(1))).unwrap_err().contains("version 1"));
    }

    #[test]
    fn caps_the_pair_count() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GGUF");
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&(MAX_KV + 1).to_le_bytes());
        assert!(parse(Cursor::new(bytes)).is_err());
    }

    #[test]
    fn an_array_past_the_read_cap_stops_without_allocating() {
        // 10 GB of "elements" claimed: skipped by arithmetic, refused by the cap.
        let mut g = Gguf::new();
        g.string("general.architecture", "llama")
            .u32("llama.context_length", 4096)
            .huge_u8_array("tokenizer.huge", 10 * 1024 * 1024 * 1024)
            .u32("llama.block_count", 32);
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.context_length, Some(4096));
        assert_eq!(info.block_count, None);
        assert!(!info.complete);

        // With no architecture yet, the same failure is an error.
        let mut g = Gguf::new();
        g.huge_u8_array("tokenizer.huge", u64::MAX / 2);
        assert!(parse(Cursor::new(g.bytes(3))).is_err());
    }

    #[test]
    fn a_cut_short_header_keeps_what_was_read() {
        let bytes = llama().bytes(3);
        let cut = bytes.len() - 20;
        let info = parse(Cursor::new(bytes[..cut].to_vec())).unwrap();
        assert_eq!(info.architecture, "llama");
        assert_eq!(info.context_length, Some(8192));
        assert!(!info.complete);
    }

    #[test]
    fn a_huge_string_value_is_skipped_not_kept() {
        let mut g = Gguf::new();
        let long = "x".repeat((MAX_KEEP_STR + 1) as usize);
        g.string("general.architecture", "llama").string("general.name", &long);
        let info = parse(Cursor::new(g.bytes(3))).unwrap();
        assert_eq!(info.name, None);
        assert!(info.complete);
    }

    #[test]
    fn a_later_split_part_reads_part_one() {
        let dir = std::env::temp_dir().join(format!("gguf-split-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let one = dir.join("Model-Q4_K_M-00001-of-00003.gguf");
        let two = dir.join("Model-Q4_K_M-00002-of-00003.gguf");
        std::fs::write(&one, llama().bytes(3)).unwrap();
        std::fs::write(&two, b"tensor data only").unwrap();
        assert_eq!(first_part(&two), one);
        assert_eq!(first_part(&one), one);
        assert_eq!(read_header(&two).unwrap().context_length, Some(8192));
        let single = dir.join("model.gguf");
        assert_eq!(first_part(&single), single);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_command_is_confined_to_gguf_files() {
        assert!(gguf_info("C:/Windows/notepad.exe".to_string()).is_err());
        assert!(gguf_info("/nowhere/at/all.gguf".to_string()).is_err());
    }
}
