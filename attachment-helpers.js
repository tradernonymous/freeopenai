'use strict';

(function attachAttachmentModule(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    // Keep a namespace for the page's explicit adapter, and expose the same
    // names for old inline callers while the extraction settles in.
    root.FreeOpenAIAttachment = api;
    Object.assign(root, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function attachmentFactory() {
  const DOCUMENT_EXTENSIONS = ['.pdf', '.docx'];
  // Byte-order marks a decoder has to be told about before it guesses. UTF-16
  // text is still text: Notepad's "Unicode" save is a .txt that would otherwise
  // look like a binary file with a NUL in every other byte.
  const ATTACHMENT_BOMS = [
    { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
    { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
    { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
  ];
  const MAX_IMAGE_DATA_URL_CHARS = 700000;
  const MAX_IMAGE_EDGE = 1600;
  const STORED_IMAGE_MAX_EDGE = 1024;
  const STORED_IMAGE_MAX_CHARS = 300000;
  const MAX_STORED_IMAGES_PER_CONVERSATION = 8;

  function isDocumentFile(filename) {
    const lower = String(filename).toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  // What a picked file should become: 'image', 'document' or 'text'.
  //
  // The file decides this, never the menu item that opened the picker -- that
  // item is a filter on the file dialog, so a PDF chosen from Files was refused
  // for arriving through the wrong door. An image is decided by its MIME type,
  // which the send path needs anyway to build a data URL; a document by its
  // extension, because the parser is what has to match the format. Everything
  // else is text, and whether that is true is settled by the bytes rather than
  // by a list of nine extensions -- see decodeAttachmentText.
  function attachmentKindFor(name, type) {
    if (String(type || '').toLowerCase().startsWith('image/')) return 'image';
    return isDocumentFile(name) ? 'document' : 'text';
  }

  // A NUL byte is the one thing no text encoding produces, so it is the first
  // and strongest signal. U+FFFD is the second: a decoder that gave up on a byte
  // left that behind, which is how non-UTF-8 bytes show up. Stray control
  // characters are the third. ESC is deliberately not one of them -- that is how
  // a terminal writes colour, so a coloured log is a log -- and the ratio is
  // generous, because a text file may legitimately hold a form feed.
  function looksBinaryText(text) {
    const sample = String(text == null ? '' : text).slice(0, 4000);
    if (!sample) return false;
    if (sample.indexOf('\u0000') !== -1) return true;
    const bad = (sample.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\uFFFD]/g) || []).length;
    return bad > sample.length / 10;
  }

  // The text of an attachment, or null when the bytes are not text at all -- a
  // different answer from "unsupported file", because it points at another
  // attachment kind rather than at another file.
  //
  // What an attachment becomes is text inside a prompt, so the bytes decide.
  // The name used to: against a list of nine extensions that refused .py, .html,
  // .css, .env, .toml, Makefile and Dockerfile -- all text this app can read --
  // while waving through a .txt holding a zipped archive, which arrived in the
  // request as mojibake.
  function decodeAttachmentText(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const bom = ATTACHMENT_BOMS.find((entry) => entry.bytes.every((byte, index) => data[index] === byte));
    const body = bom ? data.subarray(bom.skip) : data;
    // An unknown encoding is a refusal, not a crash: utf-16be is not in every
    // runtime's decoder set.
    let text = '';
    try {
      text = new TextDecoder(bom ? bom.encoding : 'utf-8').decode(body);
    } catch {
      return null;
    }
    return looksBinaryText(text) ? null : text;
  }

  function acceptsImages(model) {
    return !!(model && model.vision === true);
  }

  function modelForImage(models, preferredId) {
    const list = Array.isArray(models) ? models.filter((model) => model && model.id) : [];
    if (acceptsImages(list.find((model) => model.id === preferredId))) return preferredId;
    const capable = list.find(acceptsImages);
    return capable ? capable.id : null;
  }

  function isSendableImageUrl(url) {
    return /^data:image\//i.test(String(url || '')) || /^https?:\/\//i.test(String(url || ''));
  }

  function withImageTurn(messages, imageUrl, promptText) {
    const list = Array.isArray(messages) ? messages : [];
    const last = list[list.length - 1];
    if (!last || last.role !== 'user') return list;
    if (!isSendableImageUrl(imageUrl)) {
      throw new Error('Refusing to send an image URL that is not a data:image or http(s) link');
    }
    if (Array.isArray(last.content)) return list;
    const text = String(promptText || last.content || '').trim();
    return [
      ...list.slice(0, -1),
      {
        ...last,
        content: [
          { type: 'text', text: text || 'What is in this image?' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];
  }

  function storedImagePlan(url) {
    const value = String(url || '');
    if (/^https?:\/\//i.test(value)) return 'remote';
    if (/^data:image\//i.test(value) || /^blob:/i.test(value)) return 'encode';
    return 'skip';
  }

  function capConversationImages(messages, max = MAX_STORED_IMAGES_PER_CONVERSATION) {
    const limit = Math.max(0, Number(max) || 0);
    const list = Array.isArray(messages) ? messages : [];
    const holders = [];
    list.forEach((message, index) => {
      if (message && Array.isArray(message.images) && message.images.length) holders.push(index);
    });
    const overflow = holders.length - limit;
    if (overflow <= 0) return list.slice();
    const drop = new Set(holders.slice(0, overflow));
    return list.map((message, index) => (drop.has(index) ? { ...message, images: [] } : message));
  }

  function stripStoredImages(conversations, protectId = '') {
    return (Array.isArray(conversations) ? conversations : []).map((conversation) => {
      if (!conversation) return conversation;
      if (protectId && conversation.id === protectId) return conversation;
      if (!Array.isArray(conversation.messages)) return conversation;
      if (!conversation.messages.some((message) => message && Array.isArray(message.images) && message.images.length)) {
        return conversation;
      }
      return {
        ...conversation,
        messages: conversation.messages.map((message) => (
          message && Array.isArray(message.images) && message.images.length ? { ...message, images: [] } : message
        )),
      };
    });
  }

  return {
    DOCUMENT_EXTENSIONS,
    MAX_IMAGE_DATA_URL_CHARS,
    MAX_IMAGE_EDGE,
    STORED_IMAGE_MAX_EDGE,
    STORED_IMAGE_MAX_CHARS,
    MAX_STORED_IMAGES_PER_CONVERSATION,
    isDocumentFile,
    attachmentKindFor,
    looksBinaryText,
    decodeAttachmentText,
    acceptsImages,
    modelForImage,
    isSendableImageUrl,
    withImageTurn,
    storedImagePlan,
    capConversationImages,
    stripStoredImages,
  };
});
