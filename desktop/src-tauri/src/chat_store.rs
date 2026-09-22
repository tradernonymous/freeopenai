// Chat history in a SQLite file, not in localStorage.
//
// localStorage has a quota of a few MB in WebView2; a history with pictures in
// it hit that and whole chats were dropped to make a write fit. A SQLite file
// in the app's data folder has no such ceiling.
//
// This module stores opaque rows. The frontend encrypts each chat (AES-GCM,
// src/chat-crypto.js) before it gets here, so `blob` is base64 ciphertext and
// nothing in this file ever sees a message. The key lives in the OS credential
// store under the same service name as the other secrets (secrets.rs), as its
// own entry, read and written only by the two key commands below.
//
// Rules:
//
//   * one connection, opened lazily on the first command (the app data folder
//     is known only through an AppHandle) and kept for the life of the app;
//   * WAL journal, so a write never blocks a read and a crash mid-write leaves
//     the previous state intact;
//   * a batch of rows is one transaction: all of them land, or none do.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

pub const DB_FILE: &str = "chats.sqlite3";
/// The credential-store entry holding the base64 AES key.
pub const KEY_NAME: &str = "chat_key";
/// A chat id is the app's own short token ("c" + base36); anything longer is
/// not one of ours.
const MAX_ID_LEN: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub id: String,
    pub updated_at: i64,
    pub blob: String,
}

fn err(e: rusqlite::Error) -> String {
    format!("chat store: {}", e)
}

fn slot() -> &'static Mutex<Option<Connection>> {
    static DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    DB.get_or_init(|| Mutex::new(None))
}

/// Journal mode and schema. Shared by the real file and the tests' in-memory
/// database.
fn setup(conn: &Connection) -> Result<(), String> {
    // journal_mode answers with a row, so it is read as a query, not executed.
    let _mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
        .map_err(err)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            updated_at INTEGER NOT NULL,
            blob TEXT NOT NULL
        );",
    )
    .map_err(err)?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(err)?;
    setup(&conn)?;
    Ok(conn)
}

fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= MAX_ID_LEN
}

pub fn list(conn: &Connection) -> Result<Vec<Row>, String> {
    let mut stmt = conn
        .prepare("SELECT id, updated_at, blob FROM chats ORDER BY updated_at DESC")
        .map_err(err)?;
    let mapped = stmt
        .query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                updated_at: r.get(1)?,
                blob: r.get(2)?,
            })
        })
        .map_err(err)?;
    let mut out: Vec<Row> = Vec::new();
    for row in mapped {
        out.push(row.map_err(err)?);
    }
    Ok(out)
}

/// Insert or replace every row, in one transaction.
pub fn put(conn: &mut Connection, rows: &[Row]) -> Result<usize, String> {
    for row in rows {
        if !valid_id(&row.id) {
            return Err(format!("chat store: {:?} is not a chat id", row.id));
        }
    }
    let tx = conn.transaction().map_err(err)?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO chats (id, updated_at, blob) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, blob = excluded.blob",
            )
            .map_err(err)?;
        for row in rows {
            stmt.execute(params![row.id, row.updated_at, row.blob])
                .map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(rows.len())
}

pub fn delete(conn: &mut Connection, ids: &[String]) -> Result<usize, String> {
    let tx = conn.transaction().map_err(err)?;
    let mut removed: usize = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM chats WHERE id = ?1").map_err(err)?;
        for id in ids {
            removed += stmt.execute(params![id]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(removed)
}

pub fn clear(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM chats", []).map_err(err)
}

/// Run `f` against the one connection, opening it on first use.
fn with_db<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = match slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.is_none() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data directory: {}", e))?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create {}: {}", dir.display(), e))?;
        let conn = open(&dir.join(DB_FILE))?;
        *guard = Some(conn);
    }
    match guard.as_mut() {
        Some(conn) => f(conn),
        None => Err("chat store: not open".to_string()),
    }
}

#[tauri::command(async)]
pub fn chat_store_list(app: tauri::AppHandle) -> Result<Vec<Row>, String> {
    with_db(&app, |conn| list(conn))
}

#[tauri::command(async)]
pub fn chat_store_put(app: tauri::AppHandle, rows: Vec<Row>) -> Result<usize, String> {
    with_db(&app, |conn| put(conn, &rows))
}

#[tauri::command(async)]
pub fn chat_store_delete(app: tauri::AppHandle, ids: Vec<String>) -> Result<usize, String> {
    with_db(&app, |conn| delete(conn, &ids))
}

#[tauri::command(async)]
pub fn chat_store_clear(app: tauri::AppHandle) -> Result<usize, String> {
    with_db(&app, |conn| clear(conn))
}

// ---- the key ----------------------------------------------------------------
//
// Its own entry under the app's service name. Kept here rather than added to
// secrets::KEYS so the general secret commands cannot read or overwrite it.

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(crate::secrets::SERVICE, KEY_NAME)
        .map_err(|e| format!("credential store: {}", e))
}

#[tauri::command]
pub fn chat_store_key_get() -> Result<Option<String>, String> {
    match key_entry()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("credential store: {}", e)),
    }
}

#[tauri::command]
pub fn chat_store_key_set(value: String) -> Result<(), String> {
    if value.is_empty() {
        return Err("chat store: an empty key is not a key".to_string());
    }
    key_entry()?
        .set_password(&value)
        .map_err(|e| format!("credential store: {}", e))
}

// ---- start fresh (NEURA-022) ---------------------------------------------------
//
// The key is lost or does not open the rows. Nothing here deletes anything:
// the database is renamed to chats.unreadable-<unix seconds>.sqlite3 beside
// where it was, and the old key (when there is one) is copied to its own entry
// "chat_key.unreadable-<unix seconds>" before the live entry is cleared, so the
// page can make a new key. A later recovery of the old key can still open the
// old file.

/// The name the old database is moved to. `n` > 0 when that name is taken.
pub fn aside_name(stamp: u64, n: u32) -> String {
    if n == 0 {
        format!("chats.unreadable-{}.sqlite3", stamp)
    } else {
        format!("chats.unreadable-{}-{}.sqlite3", stamp, n)
    }
}

/// Rename `dir/chats.sqlite3` (and its -wal / -shm companions, if any are
/// left) to a free chats.unreadable-* name. Ok(None) when there is no file.
/// Never overwrites: a taken name moves on to the next number.
pub fn set_aside_file(dir: &Path, stamp: u64) -> Result<Option<String>, String> {
    let main = dir.join(DB_FILE);
    if !main.exists() {
        return Ok(None);
    }
    let mut n: u32 = 0;
    let name = loop {
        let candidate = aside_name(stamp, n);
        let taken = dir.join(&candidate).exists()
            || dir.join(format!("{}-wal", candidate)).exists()
            || dir.join(format!("{}-shm", candidate)).exists();
        if !taken {
            break candidate;
        }
        n += 1;
        if n > 1000 {
            return Err("chat store: no free name to set the old file aside".to_string());
        }
    };
    std::fs::rename(&main, dir.join(&name))
        .map_err(|e| format!("chat store: could not rename {}: {}", main.display(), e))?;
    for suffix in ["-wal", "-shm"] {
        let side = dir.join(format!("{}{}", DB_FILE, suffix));
        if side.exists() {
            let _ = std::fs::rename(&side, dir.join(format!("{}{}", name, suffix)));
        }
    }
    Ok(Some(name))
}

/// Copy the live key (if any) to "chat_key.unreadable-<stamp>", then clear the
/// live entry. A copy that fails stops here, before anything is cleared.
fn set_aside_key(stamp: u64) -> Result<(), String> {
    let live = key_entry()?;
    let old = match live.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(e) => return Err(format!("credential store: {}", e)),
    };
    let backup_name = format!("{}.unreadable-{}", KEY_NAME, stamp);
    keyring::Entry::new(crate::secrets::SERVICE, &backup_name)
        .map_err(|e| format!("credential store: {}", e))?
        .set_password(&old)
        .map_err(|e| format!("credential store: {}", e))?;
    match live.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("credential store: {}", e)),
    }
}

/// "Start fresh (keep the old file)". Closes the connection (folding the WAL
/// into the file first), sets the key aside, renames the database. Answers
/// the old file's new name, or "" when there was no file. The next command
/// opens a new, empty chats.sqlite3.
#[tauri::command(async)]
pub fn chat_store_set_aside(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {}", e))?;
    let mut guard = match slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(conn) = guard.take() {
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
        drop(conn);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    set_aside_key(stamp)?;
    let moved = set_aside_file(&dir, stamp)?;
    Ok(moved.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neuraos-chat-store-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn set_aside_renames_and_never_overwrites() {
        let dir = scratch("aside");
        assert_eq!(set_aside_file(&dir, 7).unwrap(), None, "no file, nothing to do");
        std::fs::write(dir.join(DB_FILE), b"old").unwrap();
        std::fs::write(dir.join(aside_name(7, 0)), b"earlier").unwrap();
        let moved = set_aside_file(&dir, 7).unwrap();
        assert_eq!(moved, Some(aside_name(7, 1)));
        assert!(!dir.join(DB_FILE).exists());
        assert_eq!(std::fs::read(dir.join(aside_name(7, 0))).unwrap(), b"earlier");
        assert_eq!(std::fs::read(dir.join(aside_name(7, 1))).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn memory() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        setup(&conn).expect("schema");
        conn
    }

    fn row(id: &str, at: i64, blob: &str) -> Row {
        Row {
            id: id.to_string(),
            updated_at: at,
            blob: blob.to_string(),
        }
    }

    #[test]
    fn put_then_list_returns_newest_first() {
        let mut conn = memory();
        put(&mut conn, &[row("a", 1, "x"), row("b", 2, "y")]).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "b");
        assert_eq!(rows[1], row("a", 1, "x"));
    }

    #[test]
    fn put_replaces_an_existing_id() {
        let mut conn = memory();
        put(&mut conn, &[row("a", 1, "old")]).unwrap();
        put(&mut conn, &[row("a", 5, "new")]).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows, vec![row("a", 5, "new")]);
    }

    #[test]
    fn a_bad_id_rejects_the_whole_batch() {
        let mut conn = memory();
        assert!(put(&mut conn, &[row("a", 1, "x"), row(" ", 2, "y")]).is_err());
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn delete_and_clear() {
        let mut conn = memory();
        put(&mut conn, &[row("a", 1, "x"), row("b", 2, "y"), row("c", 3, "z")]).unwrap();
        let removed = delete(&mut conn, &["a".to_string(), "missing".to_string()]).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(list(&conn).unwrap().len(), 2);
        assert_eq!(clear(&conn).unwrap(), 2);
        assert!(list(&conn).unwrap().is_empty());
    }
}
