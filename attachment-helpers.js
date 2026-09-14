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
  const ATTACHABLE_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.log', '.yml', '.yaml'];
  const MAX_IMAGE_DATA_URL_CHARS = 700000;
  const MAX_IMAGE_EDGE = 1600;
  const STORED_IMAGE_MAX_EDGE = 1024;
  const STORED_IMAGE_MAX_CHARS = 300000;
  const MAX_STORED_IMAGES_PER_CONVERSATION = 8;

  function isDocumentFile(filename) {
    const lower = String(filename).toLowerCase();
    return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function isAttachableFile(filename) {
    const lower = String(filename).toLowerCase();
    return ATTACHABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
    ATTACHABLE_EXTENSIONS,
    MAX_IMAGE_DATA_URL_CHARS,
    MAX_IMAGE_EDGE,
    STORED_IMAGE_MAX_EDGE,
    STORED_IMAGE_MAX_CHARS,
    MAX_STORED_IMAGES_PER_CONVERSATION,
    isDocumentFile,
    isAttachableFile,
    acceptsImages,
    modelForImage,
    isSendableImageUrl,
    withImageTurn,
    storedImagePlan,
    capConversationImages,
    stripStoredImages,
  };
});
