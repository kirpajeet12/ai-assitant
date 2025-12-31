# Pizza 64 Voice Assistant Starter (Twilio + Web)

✅ Works for FREE testing (MOCK_AI=true).  
✅ Web UI at `/index.html`  
✅ Twilio Voice webhook at `/twilio/voice`

## Local run
```bash
cd backend
npm install
npm start
```
Open:
- http://localhost:10000/index.html
- http://localhost:10000/health

## Deploy on Render
Render Settings:
- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `npm start`

Env Vars:
- `MOCK_AI=true`

## Twilio setup (test calls)
Twilio Console -> Phone Numbers -> your number -> Voice & Fax:
- A CALL COMES IN:
  - Webhook: POST
  - URL: https://ai-assitant-n7ly.onrender.com/chat.html

Call your Twilio number and speak an order.
