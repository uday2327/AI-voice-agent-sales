# SDR Calling Agent

An outbound SDR (sales development representative) calling agent. It runs a structured sales
conversation against mock CRM context, handles common objections, books qualified meetings through
real tool calls, and produces a structured post-call summary and outcome classification.

The agent brain lives entirely in this backend. A voice layer (Vapi) is integrated as an optional
transport for speech-to-text and text-to-speech only — it never owns the conversation logic.

## Stack

- React + TypeScript + Vite frontend
- Node.js + TypeScript + Express backend
- OpenAI SDK for LLM agent turns (optional mode)
- `@vapi-ai/server-sdk` / `@vapi-ai/web` for the optional voice layer
- Local JSON/mock data for CRM, calendar, transcripts, and summaries

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The backend health endpoint runs on:

```text
GET http://localhost:3001/health
```

Expected response:

```json
{ "ok": true, "service": "ai-sdr" }
```

## Scripts

```bash
npm run dev        # frontend and backend together
npm run dev:client # Vite frontend only
npm run dev:server # Express backend only
npm run build      # TypeScript check and Vite build
npm run lint       # oxlint
```

## Design direction

The UI is a **Live Call Demo** screen — it visualizes an AI call in real time. It is intentionally
not a full operator console or CRM dashboard: no login, roles, auth, call timer, complex avatars, or
heavy animation libraries.

The screen keeps the agent (Carla) centered with a CSS-only speaking/thinking/listening indicator, a
clear End Call button, and a side transcript panel with visually separated agent and lead bubbles. A
small Recent actions area surfaces tool activity labels such as `CRM loaded`, `Calendar checked`,
`Meeting booked`, and `Summary saved`.

The agent's display name and profile come from a separate config file
(`src/server/config/agent.config.ts`) rather than being hardcoded in UI components. Lead records
include `companySize` and `discussionTopic`; the agent uses `companySize` to qualify and adapt the
pitch and `discussionTopic` to open with relevant context.

After the call ends, the outcome panel shows the classification, meeting status, interest level,
recommended next action, and call note. In production, the same backend call orchestration could
back an internal sales console or a real voice call experience.

## HTTP API

```text
GET  /api/leads
GET  /api/leads/:leadId
GET  /api/calendar/availability
GET  /api/calendar/availability?preferredDate=2026-06-29
POST /api/meetings
POST /api/call-summaries
POST /api/lead-outcomes/classify
GET  /api/agent
POST /api/calls
```

The CRM and calendar seed data live in `src/server/data`. Meeting bookings are written to ignored
runtime state under `logs/`, so demo usage never modifies the committed mock data.

## Call orchestration

### Deterministic mode (default)

`AGENT_MODE=deterministic` uses a small deterministic call flow for the main scenarios. It calls the
real CRM / calendar / summary tools and returns transcript bubbles, status events, tool calls, a
summary, and an outcome classification. It makes no LLM calls, so local demo work costs `$0`.

```text
POST /api/calls
```

```json
{ "leadId": "lead_interested" }
```

The public API deliberately uses the word "calls" rather than "simulations".

### LLM mode (optional, disabled by default)

```env
AGENT_MODE=llm
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4.1-mini
MAX_CALL_TURNS=8
MAX_OUTPUT_TOKENS=220
```

In LLM mode the backend keeps **deterministic lead replies** for repeatable testing while OpenAI
generates the agent's turns and decides when backend tools should be used. Existing backend tools
remain the source of truth for CRM context, calendar availability, meeting booking, summaries, and
classification. If `AGENT_MODE=llm` is set without a real API key, the backend returns a clear error
instead of spending unexpectedly.

### Demo Mode vs Interactive Mode

- **Demo Mode** — the scripted flow. Uses the selected mock CRM lead and predefined lead replies to
  show a complete call quickly. Available for both deterministic and LLM agent modes.
- **Interactive Mode** — a live LLM flow. The agent opens the call, then the user types the lead
  reply or uses the Mic button to speak it. The frontend sends the selected lead context,
  conversation history, and latest lead reply to the backend; the backend uses the LLM to generate
  the agent's next response and stores intent / objection / next-action reasoning internally in the
  call result and logs. The agent's latest response is spoken in the browser while the transcript
  stays visible.

The Start Call button opens a minimal setup modal:

- Agent mode: `deterministic` or `llm`
- Call mode: `demo` or `interactive` (shown only when `llm` is selected)

Interactive Mode requires `OPENAI_API_KEY` and uses the same budget controls as LLM Demo Mode.

## System prompt

The agent's main system prompt lives in `src/server/agent/carlaSystemPrompt.ts`. It defines the
agent's identity, value proposition, conversation flow, objection-handling rules, tool-calling
rules, outcome labels, safety boundaries, and the optional structured-output shape.

Deterministic mode does not use this prompt; it is the foundation for `AGENT_MODE=llm`. Tool-calling
rules are enforced conservatively — for example, `bookMeeting` is only used after the lead explicitly
agrees to a specific available slot, never on interest alone, and requests like "send me an email"
or "I'll think about it" must not trigger a booking.

## Two-minute demo

1. `npm run dev`
2. Open the Live Call Demo screen at `http://localhost:5173`.
3. Choose a lead.
4. Click **Start call**.
5. No-cost complete flow — Agent mode: `deterministic`.
6. LLM scripted flow — Agent mode: `llm`, Call mode: `demo`.
7. Manual lead conversation — Agent mode: `llm`, Call mode: `interactive`.
8. In Interactive Mode, try:
   - `Can we book a meeting?`
   - `Option 1 works`
   - `We already use Salesforce.`
   - `Budget is tight.`
   - `Send me an email.`

When a meeting is booked, the backend calls the calendar and booking tools, saves the call summary,
and the UI ends the call with a booked outcome.

## Vapi voice layer

Vapi is integrated with the official `@vapi-ai/server-sdk` as a **voice transport layer**, not as
the agent brain. The source of truth stays in this backend: lead context, conversation history, the
agent prompt, tool calling, summary, and classification. Vapi handles only speech-to-text input,
text-to-speech output, call transport, and webhook/tool events forwarded into this backend.

Keep the Vapi dashboard assistant prompt minimal:

```text
You are Carla, an AI SDR. Follow the backend-provided conversation instructions and use the configured tools. Keep responses concise, natural, and professional.
```

Do not duplicate the full agent prompt or tool logic in the Vapi dashboard.

Vapi endpoints:

```text
GET  /api/vapi/config
POST /api/vapi/calls
POST /api/vapi/webhook
POST /api/vapi/chat/completions
POST /api/vapi/turn
```

`POST /api/vapi/calls` accepts:

```json
{
  "leadId": "lead_interested",
  "customerNumber": "+15551234567"
}
```

By default, Vapi call creation runs in dry-run mode. No paid outbound call is created unless
`VAPI_ALLOW_OUTBOUND_CALLS=true`.

```env
VAPI_API_KEY=your_vapi_key_here
VAPI_PUBLIC_BASE_URL=https://your-public-backend-url.example
VAPI_PHONE_NUMBER_ID=your_vapi_phone_number_id
VAPI_ASSISTANT_ID=your_minimal_vapi_assistant_id
VAPI_ALLOW_OUTBOUND_CALLS=false
VAPI_MAX_OUTBOUND_CALLS=2
VAPI_MAX_CALL_DURATION_SECONDS=300
```

- `VAPI_ALLOW_OUTBOUND_CALLS=false` keeps local development safe by returning a planned call instead
  of creating a paid outbound call.
- `VAPI_MAX_OUTBOUND_CALLS=2` limits real Vapi outbound calls per server process.
- `VAPI_MAX_CALL_DURATION_SECONDS=300` caps transient assistant call duration.

The Live Call Demo, Demo Mode, and Interactive Text Mode remain fully usable without Vapi.

`POST /api/vapi/chat/completions` is the preferred Vapi Custom LLM endpoint. Configure the Vapi
assistant model as a custom / OpenAI-compatible server pointing at
`{VAPI_PUBLIC_BASE_URL}/api/vapi/chat/completions`. Vapi requests must include
`call.metadata.leadId` or `metadata.leadId` so the backend can load the correct mock CRM lead and
keep the existing orchestration as the agent brain.

`POST /api/vapi/turn` is a lower-level bridge for finalized voice transcripts. It accepts `leadId`,
`callId`, `transcript`, and `leadReply`, then forwards that turn into the same backend orchestration
used by Interactive Mode. The response includes the agent's next message for Vapi to speak.

The backend does not create a full transient Vapi agent. Real Vapi outbound calls require
`VAPI_ASSISTANT_ID`, and that assistant should only provide STT / TTS / call transport plus the
short wrapper prompt above. Before production voice usage, add webhook authentication, persistent
call sessions, stronger tool schemas, and real CRM / calendar integrations.

## Budget controls

Development defaults to deterministic mode, so local demo work costs `$0`. LLM mode should only be
enabled intentionally with `AGENT_MODE=llm` and a real `OPENAI_API_KEY`.

Keep `MAX_CALL_TURNS` and `MAX_OUTPUT_TOKENS` low during testing. `MAX_OUTPUT_TOKENS=220` limits
each agent response from the model, keeping calls short, predictable, and cheaper. The backend also
caps this value at 500 even if a higher value is provided.

## Secrets

Real API keys belong in `.env`. Commit `.env.example`, never `.env`.
#   A I - v o i c e - a g e n t - s a l e s  
 