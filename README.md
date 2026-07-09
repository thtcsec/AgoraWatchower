# 🛡️ AgoraWatchtower

[![Agora Logo](agora.png)](https://www.agora.io/)

**AgoraWatchtower** is a real-time, multi-camera physical security Command Center dashboard designed to showcase the power of the **Agora RTC SDK** for video surveillance, dynamic two-way voice intercom, and synchronized security alerting.

This project is a high-impact demo tool developed for Agora events and presentations. It demonstrates how Agora's low-latency, software-defined real-time network (SD-RTN) can be utilized to build secure incident-command platforms.

---

## 🌟 Key Features (Agora Showcases)

1. **Ultra-Low Latency Video Grid (Agora RTC)**
   - The dashboard dynamically displays incoming security camera feeds published by guards patrolling on-site. Video and audio streams are received with sub-second latency via Agora SD-RTN.
   
2. **Dynamic Two-Way Audio Intercom (Dynamic Client Roles)**
   - HQ dispatchers can click the **Intercom** button to talk back to guards in the field.
   - *Agora Showcase*: Demonstrates how a client can dynamically switch role from `audience` (receiving feeds) to `host` (publishing a local microphone track) in real time without disconnecting.

3. **Secure Token Server (Agora AccessToken2)**
   - Includes a FastAPI python backend that uses Agora's official token builder library to safely vend short-lived RTC tokens based on `AGORA_APP_ID` and `AGORA_APP_CERTIFICATE`.

4. **Synchronized IoT Security Canned Alerts**
   - The dashboard integrates an alert channel via WebSocket. When an incident is simulated or triggered (e.g., motion detection), the respective guard's video grid cell flashes with high-priority visual alarms.

---

## 🏗️ Architecture

```
                       [ Agora SD-RTN Channel ]
                     /                         \
         (Publish Video/Audio)             (Subscribe Video/Audio)
                   /                             \
        ┌────────────────────┐          ┌─────────────────────┐
        │  Guard Camera Node │          │ HQ Command Center   │
        │   (Mobile Phone)   │          │ (React Dashboard)   │
        └─────────┬──────────┘          └──────────┬──────────┘
                  │                                │
        (Fetch Access Token)             (Fetch Access Token)
                  │                                │
                  └──────────────┐  ┌──────────────┘
                                 ▼  ▼
                     ┌──────────────────────────┐
                     │   Python FastAPI Agent   │ (Token Server &
                     │   http://localhost:8000  │  Alert Broadcaster)
                     └──────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Configure the Environment
Create a `.env` file in the `agent/` folder:

```powershell
copy agent/.env.example agent/.env
```

Open `agent/.env` and fill in your Agora credentials:
```env
AGORA_APP_ID=your_agora_app_id_here
AGORA_APP_CERTIFICATE=your_agora_app_certificate_here
```
*Note: If no credentials are provided, the server will default to "testing mode" and client streams will run tokenless.*

### 2. Run the Token Server & Agent
Open a terminal in the root of the project:

```powershell
cd agent
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn log_exporter:app --host 0.0.0.0 --port 8000
```
The agent will launch at `http://localhost:8000`. You can verify it by visiting `http://localhost:8000/health`.

### 3. Run the Web Dashboard
Open a new terminal in the root of the project:

```powershell
cd src/web-client
npm install
npm run dev
```
The React frontend will start (usually at `http://localhost:5173`).

---

## 🎬 How to Perform the Live Demo

To run a jaw-dropping live demo showing two-way streaming and communication:

1. **Open the HQ Command Center Dashboard**:
   - Open a browser window and go to `http://localhost:5173`.
   - Enter `Dispatcher_01` as your name, set the sector/channel to `sector-alpha`, choose **Command Center** mode, and click **Initialize**.
   - You will see the empty dashboard waiting for security cameras.

2. **Connect a Patrol Guard Camera**:
   - Open another browser tab, or scan/visit the local IP address on your mobile phone (e.g., `http://<your-computer-ip>:5173`).
   - Enter `Guard_A` as the name, set the sector/channel to `sector-alpha`, choose **Patrol Guard** mode, and click **Initialize**.
   - Click **Start Patrol Feed**. Grant camera and microphone permissions.
   - Go back to the dispatcher tab: **Guard_A's video feed will instantly appear in the grid!**

3. **Demo Two-Way Audio Intercom**:
   - On the Dispatcher dashboard, click the **Intercom** button.
   - Speak into your microphone. On the Guard's window, a visual alert will flash: `"HQ is speaking to you over intercom"`, and your voice will play on the guard's device speaker.

4. **Trigger a Security Alert**:
   - On the Dispatcher dashboard, type an alert message in the demo panel (e.g., *"Breach detected at Main Gate"*) and click **Trigger Incident Warning**.
   - The card containing Guard_A's video feed will instantly flash red with a critical visual warning overlay!
