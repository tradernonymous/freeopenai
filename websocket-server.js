/**
 * WebSocket Server for Live Presence
 * Real-time user presence indicators and cursor sharing
 */

const crypto = require('crypto');

class PresenceServer {
  constructor(server) {
    this.clients = new Map(); // clientId -> { ws, userId, chatId, cursor, color }
    this.chatRooms = new Map(); // chatId -> Set of clientIds
    this.server = server;
    
    // Use raw HTTP upgrade for WebSocket
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }
  
  handleUpgrade(req, socket, head) {
    // Simple WebSocket handshake
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC110517')
      .digest('base64');
    
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n'
    );
    
    const clientId = crypto.randomBytes(8).toString('hex');
    const client = {
      ws: socket,
      userId: null,
      chatId: null,
      cursor: { x: 0, y: 0 },
      color: this.generateColor()
    };
    
    this.clients.set(clientId, client);
    
    socket.on('data', (data) => {
      this.handleMessage(clientId, data);
    });
    
    socket.on('close', () => {
      this.handleDisconnect(clientId);
    });
    
    socket.on('error', () => {
      this.handleDisconnect(clientId);
    });
  }
  
  handleMessage(clientId, data) {
    try {
      const msg = JSON.parse(data.toString());
      const client = this.clients.get(clientId);
      if (!client) return;
      
      switch (msg.type) {
        case 'join':
          client.userId = msg.userId || 'anonymous';
          client.chatId = msg.chatId;
          this.joinRoom(clientId, msg.chatId);
          this.broadcastPresence(msg.chatId);
          break;
          
        case 'cursor':
          client.cursor = msg.cursor;
          this.broadcastToRoom(client.chatId, {
            type: 'cursor',
            userId: client.userId,
            cursor: msg.cursor,
            color: client.color
          }, clientId);
          break;
          
        case 'typing':
          this.broadcastToRoom(client.chatId, {
            type: 'typing',
            userId: client.userId,
            isTyping: msg.isTyping
          }, clientId);
          break;
          
        case 'leave':
          this.leaveRoom(clientId);
          break;
      }
    } catch (e) {
      // Invalid message, ignore
    }
  }
  
  joinRoom(clientId, chatId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    // Leave previous room
    if (client.chatId) {
      this.leaveRoom(clientId);
    }
    
    client.chatId = chatId;
    
    if (!this.chatRooms.has(chatId)) {
      this.chatRooms.set(chatId, new Set());
    }
    this.chatRooms.get(chatId).add(clientId);
  }
  
  leaveRoom(clientId) {
    const client = this.clients.get(clientId);
    if (!client || !client.chatId) return;
    
    const room = this.chatRooms.get(client.chatId);
    if (room) {
      room.delete(clientId);
      if (room.size === 0) {
        this.chatRooms.delete(client.chatId);
      }
    }
    
    const chatId = client.chatId;
    client.chatId = null;
    
    this.broadcastPresence(chatId);
  }
  
  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      this.leaveRoom(clientId);
      this.clients.delete(clientId);
    }
  }
  
  broadcastPresence(chatId) {
    const room = this.chatRooms.get(chatId);
    if (!room) return;
    
    const users = [];
    for (const cid of room) {
      const client = this.clients.get(cid);
      if (client && client.userId) {
        users.push({
          userId: client.userId,
          color: client.color,
          cursor: client.cursor
        });
      }
    }
    
    this.broadcastToRoom(chatId, {
      type: 'presence',
      users,
      count: users.length
    });
  }
  
  broadcastToRoom(chatId, message, excludeId = null) {
    const room = this.chatRooms.get(chatId);
    if (!room) return;
    
    const payload = JSON.stringify(message);
    
    for (const cid of room) {
      if (cid === excludeId) continue;
      const client = this.clients.get(cid);
      if (client && client.ws && !client.ws.destroyed) {
        try {
          client.ws.write(this.encodeFrame(payload));
        } catch (e) { /* ignore */ }
      }
    }
  }
  
  encodeFrame(data) {
    const buf = Buffer.from(data);
    const len = buf.length;
    
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    
    return Buffer.concat([header, buf]);
  }
  
  generateColor() {
    const colors = [
      '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7',
      '#dda0dd', '#98d8c8', '#f7dc6f', '#bb8fce', '#85c1e9'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
  
  getStats() {
    return {
      clients: this.clients.size,
      rooms: this.chatRooms.size,
      totalUsers: [...this.clients.values()].filter(c => c.userId).length
    };
  }
}

module.exports = { PresenceServer };
