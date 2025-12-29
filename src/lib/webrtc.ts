export interface PeerConnection {
  id: string;
  connection: RTCPeerConnection;
  audioStream?: MediaStream;
  audioSender?: RTCRtpSender;
  isPolite: boolean; // For perfect negotiation pattern
  makingOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
}

// Enhanced ICE configuration with TURN servers for cross-network connectivity
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    // STUN servers
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Free TURN servers for cross-network connectivity
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all',
};

export class WebRTCManager {
  private peers: Map<string, PeerConnection> = new Map();
  private localStream: MediaStream | null = null;
  private processedStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private ws: WebSocket | null = null;
  private myId: string = '';
  private isMicEnabled: boolean = false;
  private onPeerAudio: (peerId: string, stream: MediaStream) => void;
  private onPeerDisconnect: (peerId: string) => void;
  private onUserConnected: (userId: string) => void;
  private onMicStatusChange: (userId: string, status: boolean) => void;

  constructor(
    onPeerAudio: (peerId: string, stream: MediaStream) => void,
    onPeerDisconnect: (peerId: string) => void,
    onUserConnected: (userId: string) => void,
    onMicStatusChange: (userId: string, status: boolean) => void
  ) {
    this.onPeerAudio = onPeerAudio;
    this.onPeerDisconnect = onPeerDisconnect;
    this.onUserConnected = onUserConnected;
    this.onMicStatusChange = onMicStatusChange;
  }

  getMyId(): string {
    return this.myId;
  }

  async initLocalStream(): Promise<MediaStream> {
    try {
      console.log('Requesting microphone access with enhanced audio processing...');

      // Request microphone with aggressive noise/echo cancellation
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // Advanced constraints for better noise filtering
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
        },
        video: false,
      });

      // Apply additional audio processing
      this.processedStream = await this.applyAdvancedAudioProcessing(this.localStream);

      // ALWAYS start with mic DISABLED
      this.processedStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        console.log('Audio track created and disabled:', track.id);
      });
      this.isMicEnabled = false;

      // Add tracks to all existing peer connections
      await this.addTracksToAllPeers();

      console.log('Local stream initialized with enhanced noise cancellation, mic OFF');
      return this.processedStream;
    } catch (error) {
      console.error('Error accessing microphone:', error);
      throw error;
    }
  }

  private async applyAdvancedAudioProcessing(stream: MediaStream): Promise<MediaStream> {
    try {
      // Create audio context for advanced processing
      this.audioContext = new AudioContext({ sampleRate: 48000 });

      const source = this.audioContext.createMediaStreamSource(stream);
      const destination = this.audioContext.createMediaStreamDestination();

      // Create high-pass filter to remove low frequency noise (rumble, wind)
      const highPassFilter = this.audioContext.createBiquadFilter();
      highPassFilter.type = 'highpass';
      highPassFilter.frequency.value = 85; // Cut frequencies below 85Hz (removes wind, rumble)
      highPassFilter.Q.value = 0.7;

      // Create low-pass filter to remove high frequency noise (hiss)
      const lowPassFilter = this.audioContext.createBiquadFilter();
      lowPassFilter.type = 'lowpass';
      lowPassFilter.frequency.value = 8000; // Cut frequencies above 8kHz
      lowPassFilter.Q.value = 0.7;

      // Create dynamics compressor to even out volume
      const compressor = this.audioContext.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      // Create gain node to boost voice after filtering
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.2;

      // Connect the audio processing chain
      source.connect(highPassFilter);
      highPassFilter.connect(lowPassFilter);
      lowPassFilter.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(destination);

      console.log('Advanced audio processing applied: high-pass (85Hz), low-pass (8kHz), compression');

      return destination.stream;
    } catch (error) {
      console.warn('Failed to apply advanced audio processing, using original stream:', error);
      return stream;
    }
  }

  private async addTracksToAllPeers() {
    const streamToUse = this.processedStream || this.localStream;
    if (!streamToUse) return;

    console.log('Adding tracks to all existing peers:', this.peers.size);

    for (const [peerId, peer] of this.peers) {
      await this.attachLocalAudio(peerId, peer.connection);
      await this.renegotiate(peerId, peer.connection);
    }
  }

  private async renegotiate(peerId: string, peerConnection: RTCPeerConnection) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Only renegotiate when we have an established negotiation and are stable
    if (!peerConnection.remoteDescription) return;
    if (peer.makingOffer) return;
    if (peerConnection.signalingState !== 'stable') return;

    try {
      peer.makingOffer = true;
      console.log('Renegotiating with peer:', peerId);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      this.sendToSignalingServer({
        type: 'offer',
        to: peerId,
        sdp: peerConnection.localDescription,
      });
    } catch (error) {
      console.error('Renegotiation failed:', error);
    } finally {
      peer.makingOffer = false;
    }
  }

  hasLocalStream(): boolean {
    return this.localStream !== null || this.processedStream !== null;
  }

  connectToSignalingServer(
    serverUrl: string,
    onOpen?: () => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        console.log('Connecting to signaling server:', serverUrl);

        // Timeout for connection
        const connectionTimeout = setTimeout(() => {
          console.error('WebSocket connection timeout');
          reject(new Error('Connection timeout - server not responding'));
        }, 10000);

        this.ws = new WebSocket(serverUrl);

        this.ws.onopen = () => {
          console.log('✅ WebSocket connected to signaling server');
          clearTimeout(connectionTimeout);
          onOpen?.();
        };

        this.ws.onmessage = async (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('📩 Received signaling message:', data.type, data);

            // Handle 'welcome' message from server - THIS IS THE FIX!
            if (data.type === 'welcome' && data.id) {
              this.myId = data.id;
              console.log('🆔 My ID assigned from welcome:', this.myId);
              
              // Connect to existing users
              if (data.users && Array.isArray(data.users)) {
                console.log('📋 Existing users:', data.users);
                for (const userId of data.users) {
                  this.onUserConnected(userId);
                  // Initiate connection to existing users
                  await this.createOffer(userId);
                }
              }
              
              resolve(this.myId);
              return;
            }

            // Handle other signaling messages
            await this.handleSignalingMessage(data);

            // Handle new user connected
            if (data.type === 'user-connected' && data.id) {
              console.log('👤 New user connected:', data.id);
              this.onUserConnected(data.id);
              // Initiate connection to new user
              await this.createOffer(data.id);
            }
          } catch (parseError) {
            console.error('Failed to parse message:', parseError, event.data);
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.error('❌ WebSocket error:', error);
          // Get more details about the error
          const errorMsg = `WebSocket error - check if server is running and accessible at ${serverUrl}`;
          reject(new Error(errorMsg));
        };

        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          console.log('🔌 Disconnected from signaling server', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          });

          // If closed before we got our ID, reject
          if (!this.myId) {
            reject(new Error(`Connection closed: ${event.reason || 'Unknown reason'} (code: ${event.code})`));
          }
        };
      } catch (error) {
        console.error('Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  private async handleSignalingMessage(data: any) {
    switch (data.type) {
      case 'offer':
        console.log('Received offer from:', data.from);
        await this.handleOffer(data.from, data.sdp);
        break;
      case 'answer':
        console.log('Received answer from:', data.from);
        await this.handleAnswer(data.from, data.sdp);
        break;
      case 'ice-candidate':
        await this.handleIceCandidate(data.from, data.candidate);
        break;
      case 'mic-status':
        this.onMicStatusChange(data.id, data.status);
        break;
      case 'user-disconnected':
        console.log('User disconnected:', data.id);
        this.removePeer(data.id);
        break;
    }
  }

  private async attachLocalAudio(peerId: string, peerConnection: RTCPeerConnection) {
    const peer = this.peers.get(peerId);
    const streamToUse = this.processedStream || this.localStream;
    const track = streamToUse?.getAudioTracks?.()[0];

    if (!peer || !streamToUse || !track) return;

    try {
      if (peer.audioSender) {
        if (peer.audioSender.track?.id === track.id) return;
        await peer.audioSender.replaceTrack(track);
        return;
      }

      // Fallback (should not happen): addTrack creates a new transceiver/m-line
      peer.audioSender = peerConnection.addTrack(track, streamToUse);
    } catch (error) {
      console.error('Failed to attach local audio track:', error);
    }
  }

  private async createOffer(peerId: string) {
    console.log('Creating offer for peer:', peerId);

    // Use "polite" peer pattern: the peer with smaller ID is polite
    const isPolite = this.myId < peerId;
    const peerConnection = this.createPeerConnection(peerId, isPolite);
    const peer = this.peers.get(peerId)!;

    if (peer.makingOffer || peerConnection.signalingState !== 'stable') {
      console.log('Skipping createOffer - negotiation in progress, state:', peerConnection.signalingState);
      return;
    }

    await this.attachLocalAudio(peerId, peerConnection);

    try {
      peer.makingOffer = true;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      this.sendToSignalingServer({
        type: 'offer',
        to: peerId,
        sdp: peerConnection.localDescription,
      });
    } catch (error) {
      console.error('Error creating offer:', error);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleOffer(peerId: string, sdp: RTCSessionDescriptionInit) {
    console.log('Handling offer from peer:', peerId);

    // Use "polite" peer pattern: the peer with smaller ID is polite
    const isPolite = this.myId < peerId;
    let peer = this.peers.get(peerId);
    let peerConnection: RTCPeerConnection;

    if (peer) {
      peerConnection = peer.connection;
    } else {
      peerConnection = this.createPeerConnection(peerId, isPolite);
      peer = this.peers.get(peerId)!;
    }

    // Perfect negotiation pattern: handle collision
    const offerCollision = peer.makingOffer || peerConnection.signalingState !== 'stable';
    const ignoreOffer = !peer.isPolite && offerCollision;

    if (ignoreOffer) {
      console.log('Ignoring offer due to collision (we are impolite peer)');
      return;
    }

    await this.attachLocalAudio(peerId, peerConnection);

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      
      // Process any pending ICE candidates
      if (peer.pendingCandidates.length > 0) {
        console.log('Processing', peer.pendingCandidates.length, 'pending ICE candidates');
        for (const candidate of peer.pendingCandidates) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        peer.pendingCandidates = [];
      }
      
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      this.sendToSignalingServer({
        type: 'answer',
        to: peerId,
        sdp: answer,
      });
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  private async handleAnswer(peerId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn('No peer found for answer:', peerId);
      return;
    }

    // Perfect negotiation: only accept answer if we're expecting one
    if (peer.connection.signalingState !== 'have-local-offer') {
      console.log('Ignoring answer - not in have-local-offer state, current state:', peer.connection.signalingState);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp));
      
      // Process any pending ICE candidates
      if (peer.pendingCandidates.length > 0) {
        console.log('Processing', peer.pendingCandidates.length, 'pending ICE candidates after answer');
        for (const candidate of peer.pendingCandidates) {
          await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        peer.pendingCandidates = [];
      }
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }

  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = this.peers.get(peerId);
    if (!peer || !candidate) return;

    try {
      // If remote description is not set yet, queue the candidate
      if (!peer.connection.remoteDescription) {
        console.log('Queueing ICE candidate for peer:', peerId);
        peer.pendingCandidates.push(candidate);
        return;
      }

      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  }

  private createPeerConnection(peerId: string, isPolite: boolean = false): RTCPeerConnection {
    // Check if connection already exists
    const existingPeer = this.peers.get(peerId);
    if (existingPeer) {
      console.log('Reusing existing peer connection for:', peerId);
      return existingPeer.connection;
    }

    console.log('Creating new peer connection for:', peerId, 'isPolite:', isPolite);
    const peerConnection = new RTCPeerConnection(ICE_SERVERS);

    // Create a single, stable audio transceiver so later track changes don't create new m-lines
    const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendToSignalingServer({
          type: 'ice-candidate',
          to: peerId,
          candidate: event.candidate,
        });
      }
    };

    peerConnection.ontrack = (event) => {
      console.log('Received track from peer:', peerId, 'kind:', event.track.kind);
      const [remoteStream] = event.streams;

      // CRITICAL: Skip our own audio to prevent echo/hearing ourselves
      if (peerId === this.myId) {
        console.log('Skipping own audio stream to prevent echo');
        return;
      }

      console.log('Playing remote audio from peer:', peerId);
      this.onPeerAudio(peerId, remoteStream);
    };

    peerConnection.onconnectionstatechange = () => {
      console.log(`Peer ${peerId} connection state:`, peerConnection.connectionState);
      if (peerConnection.connectionState === 'disconnected' ||
          peerConnection.connectionState === 'failed') {
        this.removePeer(peerId);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log(`Peer ${peerId} ICE state:`, peerConnection.iceConnectionState);
    };

    this.peers.set(peerId, {
      id: peerId,
      connection: peerConnection,
      audioSender: audioTransceiver.sender,
      isPolite,
      makingOffer: false,
      pendingCandidates: [],
    });

    return peerConnection;
  }

  private sendToSignalingServer(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('Sending to signaling server:', message.type);
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not ready, cannot send:', message.type);
    }
  }

  sendMicStatus(status: boolean) {
    this.sendToSignalingServer({
      type: 'mic-status',
      status,
    });
  }

  toggleMic(enabled: boolean) {
    console.log('toggleMic called with:', enabled);

    const streamToUse = this.processedStream || this.localStream;
    if (streamToUse) {
      streamToUse.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
        console.log('Audio track enabled:', track.enabled, 'id:', track.id);
      });
    } else {
      console.warn('No local stream to toggle mic');
    }
    this.isMicEnabled = enabled;
    this.sendMicStatus(enabled);
  }

  isMicOn(): boolean {
    return this.isMicEnabled;
  }

  private removePeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connection.close();
      this.peers.delete(peerId);
      this.onPeerDisconnect(peerId);
    }
  }

  disconnect() {
    console.log('Disconnecting WebRTC manager...');
    this.peers.forEach((peer) => {
      peer.connection.close();
    });
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    if (this.processedStream) {
      this.processedStream.getTracks().forEach((track) => track.stop());
      this.processedStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
