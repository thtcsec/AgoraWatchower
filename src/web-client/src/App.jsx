import React, { useState, useEffect, useRef } from 'react';
import AgoraRTC from 'agora-rtc-sdk-ng';
import { 
  Shield, 
  Radio, 
  Users, 
  Bell, 
  AlertTriangle, 
  Mic, 
  MicOff, 
  Video, 
  VideoOff, 
  LogOut, 
  Send, 
  Activity,
  Volume2
} from 'lucide-react';

// Help helper for video playback
const VideoPlayer = ({ user }) => {
  const containerRef = useRef(null);

  useEffect(() => {
    if (user && user.videoTrack && containerRef.current) {
      user.videoTrack.play(containerRef.current);
    }
    return () => {
      if (user && user.videoTrack) {
        user.videoTrack.stop();
      }
    };
  }, [user]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', backgroundColor: '#000' }} />;
};

function App() {
  // Login form state
  const [sessionActive, setSessionActive] = useState(false);
  const [role, setRole] = useState('dashboard'); // 'dashboard' | 'guard'
  const [operatorName, setOperatorName] = useState('');
  const [channelName, setChannelName] = useState('watchtower-demo');
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [appId, setAppId] = useState('');

  // Agora State (Command Center / Dashboard)
  const [rtcClient, setRtcClient] = useState(null);
  const [remoteUsers, setRemoteUsers] = useState([]);
  const [isIntercomActive, setIsIntercomActive] = useState(false);
  const [localAudioTrack, setLocalAudioTrack] = useState(null);

  // Agora State (Guard / Publisher)
  const [isStreaming, setIsStreaming] = useState(false);
  const [localVideoTrack, setLocalVideoTrack] = useState(null);
  const [isIntercomIncoming, setIsIntercomIncoming] = useState(false);

  // WebSocket & Alerts State
  const [ws, setWs] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [activeAlertUids, setActiveAlertUids] = useState({}); // mapping uid -> alertMsg

  // Simulate parameters
  const [alertText, setAlertText] = useState('Motion detected in Server Room');

  // Load basic configurations from server status on mount
  useEffect(() => {
    // If agent is running, check default APP ID
    fetch('http://localhost:8000/health')
      .then(res => res.json())
      .catch(() => null);
  }, []);

  // Connect to Agent's WebSocket for alerts
  useEffect(() => {
    if (sessionActive && role === 'dashboard') {
      const socket = new WebSocket('ws://localhost:8000/ws/logs');
      socket.onopen = () => {
        console.log('Connected to alert agent WebSocket.');
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Handle custom alert structures or Syslog/Agent warnings
          if (data.type === 'alert' || data.severity === 'critical' || data.severity === 'error') {
            const newAlert = {
              id: Date.now() + Math.random(),
              timestamp: new Date().toLocaleTimeString(),
              message: data.message || data.rawData || 'Unspecified Security Event',
              source: data.source || 'Syslog',
              severity: data.severity || 'critical'
            };
            setAlerts(prev => [newAlert, ...prev]);

            // Flash camera border if source corresponds to a guard's UID
            if (data.source) {
              setActiveAlertUids(prev => ({
                ...prev,
                [data.source]: data.message
              }));
              // Reset alert flashing after 8 seconds
              setTimeout(() => {
                setActiveAlertUids(prev => {
                  const copy = { ...prev };
                  delete copy[data.source];
                  return copy;
                });
              }, 8000);
            }
          }
        } catch (e) {
          // Normal log lines can be ignored or logged
        }
      };
      socket.onclose = () => {
        console.log('Alert agent WebSocket disconnected.');
      };
      setWs(socket);
      return () => socket.close();
    }
  }, [sessionActive, role]);

  // Join Room logic
  const handleJoin = async (e) => {
    e.preventDefault();
    if (!operatorName.trim() || !channelName.trim()) {
      setErrorMsg('Please enter Operator Name and Sector ID.');
      return;
    }

    setIsConnecting(true);
    setErrorMsg('');

    try {
      // 1. Fetch Agora Token from Backend Agent
      const response = await fetch(
        `http://localhost:8000/api/token?channelName=${channelName}&uid=${operatorName}&role=${role === 'guard' ? 1 : 2}`
      );
      
      if (!response.ok) {
        throw new Error('Failed to retrieve token from Agora Token Server.');
      }
      
      const data = await response.json();
      const resolvedAppId = data.appId || 'demo_app_id';
      setAppId(resolvedAppId);

      // 2. Initialize Agora Client
      const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' });
      setRtcClient(client);

      if (role === 'dashboard') {
        // Command Center Setup
        await client.setClientRole('audience');
        await client.join(resolvedAppId, channelName, data.token === 'dummy_token' ? null : data.token, operatorName);

        // Listen for publishers
        client.on('user-published', async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === 'video') {
            setRemoteUsers(prev => {
              if (prev.find(u => u.uid === user.uid)) return prev;
              return [...prev, user];
            });
          }
          if (mediaType === 'audio') {
            user.audioTrack.play();
          }
        });

        client.on('user-unpublished', (user, mediaType) => {
          if (mediaType === 'video') {
            setRemoteUsers(prev => prev.filter(u => u.uid !== user.uid));
          }
        });

        client.on('user-left', (user) => {
          setRemoteUsers(prev => prev.filter(u => u.uid !== user.uid));
        });

      } else {
        // Guard / Publisher Setup
        await client.setClientRole('host');
        await client.join(resolvedAppId, channelName, data.token === 'dummy_token' ? null : data.token, operatorName);

        // Listen for Intercom audio from Command Center
        client.on('user-published', async (user, mediaType) => {
          await client.subscribe(user, mediaType);
          if (mediaType === 'audio') {
            user.audioTrack.play();
            setIsIntercomIncoming(true);
          }
        });

        client.on('user-unpublished', (user, mediaType) => {
          if (mediaType === 'audio') {
            setIsIntercomIncoming(false);
          }
        });
      }

      setSessionActive(true);
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || 'Error occurred while connecting to Agora.');
    } finally {
      setIsConnecting(false);
    }
  };

  // Leave room logic
  const handleLeave = async () => {
    if (localAudioTrack) {
      localAudioTrack.close();
      localAudioTrack.stop();
    }
    if (localVideoTrack) {
      localVideoTrack.close();
      localVideoTrack.stop();
    }
    if (rtcClient) {
      await rtcClient.leave();
    }

    setRtcClient(null);
    setRemoteUsers([]);
    setLocalAudioTrack(null);
    setLocalVideoTrack(null);
    setIsStreaming(false);
    setIsIntercomActive(false);
    setIsIntercomIncoming(false);
    setSessionActive(false);
    setAlerts([]);
    setActiveAlertUids({});
  };

  // Dashboard: Toggle Intercom (talking back to all guards in the channel)
  const toggleIntercom = async () => {
    if (!rtcClient) return;

    try {
      if (isIntercomActive) {
        // Stop Intercom: Unpublish & demote to audience
        if (localAudioTrack) {
          await rtcClient.unpublish(localAudioTrack);
          localAudioTrack.stop();
          localAudioTrack.close();
          setLocalAudioTrack(null);
        }
        await rtcClient.setClientRole('audience');
        setIsIntercomActive(false);
      } else {
        // Start Intercom: Promote to host & publish audio
        await rtcClient.setClientRole('host');
        const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        setLocalAudioTrack(audioTrack);
        await rtcClient.publish(audioTrack);
        setIsIntercomActive(true);
      }
    } catch (err) {
      console.error('Failed to toggle Intercom:', err);
    }
  };

  // Guard: Start/Stop Camera stream
  const toggleGuardStream = async () => {
    if (!rtcClient) return;

    if (isStreaming) {
      // Stop Stream
      if (localVideoTrack) {
        await rtcClient.unpublish(localVideoTrack);
        localVideoTrack.stop();
        localVideoTrack.close();
        setLocalVideoTrack(null);
      }
      if (localAudioTrack) {
        await rtcClient.unpublish(localAudioTrack);
        localAudioTrack.stop();
        localAudioTrack.close();
        setLocalAudioTrack(null);
      }
      setIsStreaming(false);
    } else {
      // Start Stream
      try {
        const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        const videoTrack = await AgoraRTC.createCameraVideoTrack();
        
        setLocalAudioTrack(audioTrack);
        setLocalVideoTrack(videoTrack);

        await rtcClient.publish([audioTrack, videoTrack]);
        
        // Play local camera preview
        const localPreview = document.getElementById('local-guard-preview');
        if (localPreview) {
          videoTrack.play(localPreview);
        }
        
        setIsStreaming(true);
      } catch (err) {
        console.error('Failed to access camera/mic:', err);
        alert('Could not start camera feed. Please check hardware permissions.');
      }
    }
  };

  // Trigger simulated alert from UI
  const triggerMockAlert = async () => {
    try {
      const targetSource = remoteUsers.length > 0 ? remoteUsers[0].uid : 'Patrol Guard A';
      await fetch('http://localhost:8000/api/alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: alertText,
          severity: 'critical',
          source: String(targetSource),
          channel: channelName
        })
      });
    } catch (err) {
      console.error('Failed to trigger mock alert:', err);
    }
  };

  if (!sessionActive) {
    return (
      <div className="login-container">
        <form className="login-card" onSubmit={handleJoin}>
          <div className="login-logo">🛡️ AGORA WATCHTOWER</div>
          <div className="login-subtitle">Incident Command & Remote Patrol Center</div>
          
          {errorMsg && (
            <div style={{ color: 'var(--color-red)', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 600 }}>
              {errorMsg}
            </div>
          )}

          <div className="form-group">
            <label>Interface Mode</label>
            <div className="role-selector">
              <button 
                type="button" 
                className={`role-btn ${role === 'dashboard' ? 'active' : ''}`}
                onClick={() => setRole('dashboard')}
              >
                Command Center
              </button>
              <button 
                type="button" 
                className={`role-btn ${role === 'guard' ? 'active' : ''}`}
                onClick={() => setRole('guard')}
              >
                Patrol Guard
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>{role === 'dashboard' ? 'Operator Name' : 'Guard Display Name'}</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. Operator_01" 
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              required
            />
          </div>

          <div className="form-group">
            <label>Security Sector / Channel ID</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="e.g. Sector-4" 
              value={channelName}
              onChange={(e) => setChannelName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              required
            />
          </div>

          <button type="submit" className="login-btn" disabled={isConnecting}>
            {isConnecting ? 'ESTABLISHING CONNECTION...' : 'INITIALIZE SESSION'}
          </button>
        </form>
      </div>
    );
  }

  // Guard View JSX
  if (sessionActive && role === 'guard') {
    return (
      <div className="app-container">
        <header className="top-bar">
          <div className="brand-section">
            <Shield className="brand-icon" style={{ color: 'var(--color-cyan)' }} />
            <div className="brand-title">AGORA WATCHTOWER</div>
            <div className="room-badge">GUARD PORTAL</div>
          </div>
          <div className="user-section">
            <div className="user-info">
              <div className="user-name">{operatorName}</div>
              <div className="user-role">Sector: {channelName}</div>
            </div>
            <button className="leave-btn" onClick={handleLeave}>✕ DISCONNECT</button>
          </div>
        </header>

        <main className="guard-container">
          <div className="guard-card">
            <div className="guard-preview-box" id="local-guard-preview">
              {!isStreaming && (
                <div className="camera-placeholder">
                  <VideoOff size={48} />
                  <span>Camera stream is offline.</span>
                </div>
              )}
            </div>
            <div className="guard-details">
              <div className="guard-status-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div className={`status-dot ${isStreaming ? 'active' : 'inactive'}`}></div>
                  <span style={{ fontWeight: 600 }}>{isStreaming ? 'LIVE PATROL FEED ACTIVE' : 'PATROL IDLE'}</span>
                </div>
                {isIntercomIncoming && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--color-cyan)', fontSize: '0.85rem' }}>
                    <Volume2 size={16} />
                    <span>HQ Intercom Active</span>
                  </div>
                )}
              </div>

              <button 
                className={`stream-toggle-btn ${isStreaming ? 'on' : 'off'}`}
                onClick={toggleGuardStream}
              >
                {isStreaming ? 'STOP PATROL FEED' : 'START PATROL FEED'}
              </button>

              {isIntercomIncoming && (
                <div className="intercom-alert">
                  📢 HEADQUARTERS IS SPEAKING TO YOU OVER INTERCOM
                </div>
              )}
            </div>
          </div>
        </main>
        
        <footer className="footer-bar">
          <span>Agora RTC Engine active</span>
          <span>Security Operation Node</span>
        </footer>
      </div>
    );
  }

  // Dashboard View JSX
  return (
    <div className="app-container">
      <header className="top-bar">
        <div className="brand-section">
          <Shield className="brand-icon" style={{ color: 'var(--color-cyan)' }} />
          <div className="brand-title">AGORA WATCHTOWER</div>
          <div className="room-badge">COMMAND CENTER</div>
          <div className="room-badge">{channelName.toUpperCase()}</div>
        </div>
        <div className="user-section">
          <button 
            className={`intercom-btn ${isIntercomActive ? 'active' : ''}`}
            onClick={toggleIntercom}
          >
            {isIntercomActive ? <Mic size={16} /> : <MicOff size={16} />}
            {isIntercomActive ? 'HQ INTERCOM: BROADCASTING' : 'HQ INTERCOM: MUTED'}
          </button>
          <div className="user-info">
            <div className="user-name">{operatorName}</div>
            <div className="user-role">System Dispatcher</div>
          </div>
          <button className="leave-btn" onClick={handleLeave}>✕ END SESSION</button>
        </div>
      </header>

      <main className="main-layout">
        {/* Left: Dynamic Video Grid */}
        <div className="dashboard-grid">
          {remoteUsers.length === 0 ? (
            <div className="camera-card" style={{ gridColumn: '1 / -1', minHeight: '300px' }}>
              <div className="camera-placeholder">
                <Video size={48} style={{ color: 'var(--text-muted)' }} />
                <h3>No Active Patrol Feeds</h3>
                <p style={{ fontSize: '0.85rem' }}>Open a new browser window/mobile phone as a "Patrol Guard" to stream cameras here.</p>
              </div>
            </div>
          ) : (
            remoteUsers.map((user) => {
              const hasAlert = activeAlertUids[user.uid];
              return (
                <div key={user.uid} className={`camera-card ${hasAlert ? 'alert-active' : ''}`}>
                  <div className="video-container">
                    <VideoPlayer user={user} />
                    <div className="camera-overlay">
                      <div className="camera-name">{user.uid}</div>
                      <div className="camera-status">
                        <div className="status-dot active"></div>
                        <span>LIVE</span>
                      </div>
                    </div>
                    {hasAlert && (
                      <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'rgba(239, 68, 68, 0.95)',
                        color: 'white',
                        padding: '0.5rem',
                        fontSize: '0.75rem',
                        fontWeight: 'bold',
                        textAlign: 'center',
                        zIndex: 6
                      }}>
                        ⚠️ ALERT: {hasAlert}
                      </div>
                    )}
                  </div>
                  <div className="camera-controls">
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Agora RTC Receiver
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', color: 'var(--color-green)', fontSize: '0.75rem' }}>
                      <Activity size={12} />
                      Connected
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right Sidebar: Security Alerts & Controls */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <Bell size={16} style={{ color: 'var(--color-cyan)' }} />
            <h2 className="sidebar-title">Security Alert Log</h2>
          </div>

          <div className="alerts-list">
            {alerts.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', marginTop: '2rem' }}>
                No active threats detected.
              </div>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className="alert-item">
                  <div className="alert-time">{alert.timestamp}</div>
                  <div className="alert-msg">{alert.message}</div>
                  <div className="alert-source">Source: {alert.source}</div>
                </div>
              ))
            )}
          </div>

          <div className="sim-controls">
            <h3 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px' }}>
              Simulate Alerts (Demo Controls)
            </h3>
            <input 
              type="text" 
              className="form-input" 
              style={{ fontSize: '0.8rem', padding: '0.5rem' }}
              value={alertText} 
              onChange={(e) => setAlertText(e.target.value)} 
            />
            <button className="btn-secondary" onClick={triggerMockAlert}>
              Trigger Incident Warning
            </button>
          </div>
        </aside>
      </main>

      <footer className="footer-bar">
        <span>Channel Room: {channelName}</span>
        <span>SD-RTN Latency Optimization Active</span>
      </footer>
    </div>
  );
}

export default App;
