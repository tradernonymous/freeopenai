# New API Endpoints Documentation

## Comments API

### GET /api/comments
Get comments for a shared chat.

**Query Parameters:**
- `shareId` (required) - The share ID to get comments for

**Response:**
```json
{
  "comments": [
    {
      "id": "abc123",
      "shareId": "share-xyz",
      "userId": "user-123",
      "content": "Great chat!",
      "parentId": null,
      "createdAt": 1695312000000,
      "updatedAt": 1695312000000
    }
  ]
}
```

**Rate Limit:** 60 requests per minute

---

### POST /api/comments
Add a comment to a shared chat.

**Request Body:**
```json
{
  "shareId": "share-xyz",
  "content": "Great chat!",
  "parentId": null  // Optional, for threaded comments
}
```

**Response:**
```json
{
  "id": "abc123",
  "shareId": "share-xyz",
  "userId": "user-123",
  "content": "Great chat!",
  "parentId": null,
  "createdAt": 1695312000000,
  "updatedAt": 1695312000000
}
```

**Rate Limit:** 10 requests per minute

---

### DELETE /api/comments
Delete a comment (only your own).

**Request Body:**
```json
{
  "shareId": "share-xyz",
  "commentId": "abc123"
}
```

**Response:** `200 OK` or `404 Not Found`

**Rate Limit:** 20 requests per minute

---

## Fork API

### POST /api/fork
Fork a shared chat into your workspace.

**Request Body:**
```json
{
  "shareId": "share-xyz"
}
```

**Response:**
```json
{
  "forked": true,
  "shareId": "share-xyz",
  "targetUserId": "user-123",
  "forkedAt": 1695312000000
}
```

**Authentication:** Required (returns 401 if not signed in)

**Rate Limit:** 5 requests per minute

---

## Workspace API

### GET /api/workspace
Get workspace directory info for current user.

**Query Parameters:**
- `sessionId` (optional) - Session ID (defaults to "default")

**Response:**
```json
{
  "dir": "/app/workspace/user-123/session-456",
  "userId": "user-123",
  "sessionId": "session-456"
}
```

**Rate Limit:** 30 requests per minute

---

### POST /api/workspace/cleanup
Trigger manual cleanup of expired workspaces.

**Response:**
```json
{
  "cleaned": 5
}
```

**Rate Limit:** 1 request per 5 minutes

---

## WebSocket (Live Presence)

Connect via WebSocket upgrade to `/` with authentication.

**Authentication:**
- Pass `fo_session` cookie or `?token=JWT` query parameter
- Token format: HMAC-SHA256 signed JWT

**Message Types:**

### Join Room
```json
{
  "type": "join",
  "chatId": "chat-123"
}
```

### Cursor Update
```json
{
  "type": "cursor",
  "cursor": { "x": 100, "y": 200 }
}
```

### Typing Indicator
```json
{
  "type": "typing",
  "isTyping": true
}
```

### Leave Room
```json
{
  "type": "leave"
}
```

**Server Responses:**

### Presence Update
```json
{
  "type": "presence",
  "users": [
    { "userId": "user-1", "color": "#ff6b6b", "cursor": { "x": 100, "y": 200 } }
  ],
  "count": 1
}
```

### Cursor Broadcast
```json
{
  "type": "cursor",
  "userId": "user-1",
  "cursor": { "x": 100, "y": 200 },
  "color": "#ff6b6b"
}
```

---

## Rate Limiting

All new endpoints are rate-limited:

| Endpoint | Limit | Window |
|----------|-------|--------|
| GET /api/comments | 60 req | 1 min |
| POST /api/comments | 10 req | 1 min |
| DELETE /api/comments | 20 req | 1 min |
| POST /api/fork | 5 req | 1 min |
| GET /api/workspace | 30 req | 1 min |
| POST /api/workspace/cleanup | 1 req | 5 min |

**Rate Limit Headers:**
- `X-RateLimit-Remaining`: Requests remaining
- `X-RateLimit-Reset`: Unix timestamp when limit resets
- `Retry-After`: Seconds until next request allowed (on 429)

---

## Offline Storage

Client-side IndexedDB storage for offline access:

- **Conversations**: Cached for offline viewing
- **Messages**: Stored per conversation
- **Settings**: Persisted across sessions
- **Sync Queue**: Offline changes sync when back online

**Usage:**
```javascript
// Save conversation
await OfflineStorage.saveConversation({
  id: 'chat-123',
  title: 'My Chat',
  messages: [...]
});

// Get conversation
const chat = await OfflineStorage.getConversation('chat-123');

// Get all conversations
const allChats = await OfflineStorage.getAllConversations();
```
