import { io, Socket } from 'socket.io-client';

export interface Message {
  id: string;
  fromUserId: string;
  username: string;
  message: string;
  timestamp: string;
  isLocal?: boolean;
}

export interface Participant {
  userId: string;
  username: string;
}

export interface WebRTCServiceCallbacks {
  onMessage: (message: Message) => void;
  onParticipantJoined: (participant: Participant) => void;
  onParticipantLeft: (participant: Participant) => void;
  onConnectionStateChange: (state: string) => void;
  onError: (error: string) => void;
}

export class WebRTCService {
  private socket: Socket | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private callbacks: WebRTCServiceCallbacks;
  private currentUserId: string = '';
  private currentUsername: string = '';
  private currentRoomId: string = '';

  // STUN/TURN server configuration
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  constructor(callbacks: WebRTCServiceCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(serverUrl: string = 'http://localhost:5000'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(serverUrl);
      
      this.socket.on('connect', () => {
        this.currentUserId = this.socket!.id || '';
        console.log('Connected to signaling server:', this.currentUserId);
        this.callbacks.onConnectionStateChange('connected');
        resolve();
      });

      this.socket.on('connect_error', (error: Error) => {
        console.error('Connection error:', error);
        this.callbacks.onConnectionStateChange('disconnected');
        this.callbacks.onError('Failed to connect to server');
        reject(error);
      });

      this.setupSocketListeners();
    });
  }

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('room-joined', (data) => {
      console.log('Joined room:', data);
      this.currentRoomId = data.roomId;
      
      // Add all existing participants to the callbacks
      data.participants.forEach((participant: Participant) => {
        if (participant.userId !== this.currentUserId) {
          this.callbacks.onParticipantJoined({
            userId: participant.userId,
            username: participant.username
          });
          // Establish P2P connections with existing participants
          this.createPeerConnection(participant.userId);
        }
      });
    });

    this.socket.on('user-joined', (data) => {
      console.log('User joined:', data);
      this.callbacks.onParticipantJoined({
        userId: data.userId,
        username: data.username
      });
      
      // Create P2P connection with new user
      this.createPeerConnection(data.userId);
    });

    this.socket.on('user-left', (data) => {
      console.log('User left:', data);
      this.callbacks.onParticipantLeft({
        userId: data.userId,
        username: data.username
      });
      
      // Clean up P2P connection
      this.closePeerConnection(data.userId);
    });

    this.socket.on('offer', async (data) => {
      console.log('Received offer from:', data.fromUserId);
      await this.handleOffer(data.fromUserId, data.offer);
    });

    this.socket.on('answer', async (data) => {
      console.log('Received answer from:', data.fromUserId);
      await this.handleAnswer(data.fromUserId, data.answer);
    });

    this.socket.on('ice-candidate', async (data) => {
      console.log('Received ICE candidate from:', data.fromUserId);
      await this.handleIceCandidate(data.fromUserId, data.candidate);
    });

    // Fallback for non-P2P messages
    this.socket.on('message', (data) => {
      const message: Message = {
        id: `${data.fromUserId}-${Date.now()}`,
        fromUserId: data.fromUserId,
        username: data.username,
        message: data.message,
        timestamp: data.timestamp
      };
      this.callbacks.onMessage(message);
    });
  }

  async joinRoom(roomId: string, username: string): Promise<void> {
    this.currentUsername = username;
    this.currentRoomId = roomId;
    
    if (this.socket) {
      this.socket.emit('join-room', { roomId, username });
    }
  }

  async createRoom(): Promise<string> {
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();
      return data.roomId;
    } catch (error) {
      console.error('Failed to create room:', error);
      this.callbacks.onError('Failed to create room');
      throw error;
    }
  }

  private async createPeerConnection(targetUserId: string): Promise<void> {
    try {
      const peerConnection = new RTCPeerConnection({
        iceServers: this.iceServers
      });

      // Set up data channel
      const dataChannel = peerConnection.createDataChannel('chat', {
        ordered: true
      });

      this.setupDataChannel(dataChannel, targetUserId);
      this.setupPeerConnectionEvents(peerConnection, targetUserId);

      this.peerConnections.set(targetUserId, peerConnection);
      this.dataChannels.set(targetUserId, dataChannel);

      // Create and send offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      
      if (this.socket) {
        this.socket.emit('offer', {
          targetUserId,
          offer
        });
      }
    } catch (error) {
      console.error('Error creating peer connection:', error);
      this.callbacks.onError('Failed to establish P2P connection');
    }
  }

  private setupDataChannel(dataChannel: RTCDataChannel, targetUserId: string): void {
    dataChannel.onopen = () => {
      console.log('Data channel opened with:', targetUserId);
      this.callbacks.onConnectionStateChange('connected');
    };

    dataChannel.onclose = () => {
      console.log('Data channel closed with:', targetUserId);
      this.callbacks.onConnectionStateChange('disconnected');
    };

    dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.callbacks.onError('Data channel error');
    };

    dataChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const message: Message = {
          id: `${targetUserId}-${Date.now()}`,
          fromUserId: targetUserId,
          username: data.username || 'Unknown',
          message: data.message,
          timestamp: data.timestamp || new Date().toISOString()
        };
        this.callbacks.onMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    };
  }

  private setupPeerConnectionEvents(peerConnection: RTCPeerConnection, targetUserId: string): void {
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        this.socket.emit('ice-candidate', {
          targetUserId,
          candidate: event.candidate
        });
      }
    };

    peerConnection.ondatachannel = (event) => {
      const dataChannel = event.channel;
      this.setupDataChannel(dataChannel, targetUserId);
      this.dataChannels.set(targetUserId, dataChannel);
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state changed:', peerConnection.connectionState);
      this.callbacks.onConnectionStateChange(peerConnection.connectionState);
    };
  }

  private async handleOffer(fromUserId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    try {
      let peerConnection = this.peerConnections.get(fromUserId);
      
      if (!peerConnection) {
        peerConnection = new RTCPeerConnection({
          iceServers: this.iceServers
        });
        this.setupPeerConnectionEvents(peerConnection, fromUserId);
        this.peerConnections.set(fromUserId, peerConnection);
      }

      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      if (this.socket) {
        this.socket.emit('answer', {
          targetUserId: fromUserId,
          answer
        });
      }
    } catch (error) {
      console.error('Error handling offer:', error);
      this.callbacks.onError('Failed to handle connection offer');
    }
  }

  private async handleAnswer(fromUserId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    try {
      const peerConnection = this.peerConnections.get(fromUserId);
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('Successfully handled answer from:', fromUserId);
      } else {
        console.warn('No peer connection found for user:', fromUserId);
      }
    } catch (error) {
      console.error('Error handling answer:', error);
      // Don't show error for failed answer handling as it might just be a timing issue
    }
  }

  private async handleIceCandidate(fromUserId: string, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      const peerConnection = this.peerConnections.get(fromUserId);
      if (peerConnection) {
        await peerConnection.addIceCandidate(candidate);
      }
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  }

  sendMessage(message: string): void {
    const messageData = {
      username: this.currentUsername,
      message: message,
      timestamp: new Date().toISOString()
    };

    // Send via P2P data channels
    let sentViaP2P = false;
    this.dataChannels.forEach((dataChannel, userId) => {
      if (dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(messageData));
        sentViaP2P = true;
      }
    });

    // Fallback to server relay if no P2P connections
    if (!sentViaP2P && this.socket) {
      this.socket.emit('message', { message });
    }

    // Show local message immediately
    const localMessage: Message = {
      id: `local-${Date.now()}`,
      fromUserId: this.currentUserId,
      username: this.currentUsername,
      message: message,
      timestamp: new Date().toISOString(),
      isLocal: true
    };
    this.callbacks.onMessage(localMessage);
  }

  private closePeerConnection(userId: string): void {
    const peerConnection = this.peerConnections.get(userId);
    if (peerConnection) {
      peerConnection.close();
      this.peerConnections.delete(userId);
    }
    
    const dataChannel = this.dataChannels.get(userId);
    if (dataChannel) {
      dataChannel.close();
      this.dataChannels.delete(userId);
    }
  }

  disconnect(): void {
    // Close all P2P connections
    this.peerConnections.forEach((peerConnection) => {
      peerConnection.close();
    });
    this.peerConnections.clear();
    this.dataChannels.clear();

    // Disconnect from signaling server
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  getConnectionState(): string {
    const states = Array.from(this.peerConnections.values()).map(pc => pc.connectionState);
    if (states.includes('connected')) return 'connected';
    if (states.includes('connecting')) return 'connecting';
    return 'disconnected';
  }

  getParticipantCount(): number {
    return this.peerConnections.size + 1; // +1 for self
  }
}
