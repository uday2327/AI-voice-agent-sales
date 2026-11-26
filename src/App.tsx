import Vapi from '@vapi-ai/web'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const VapiClient = (Vapi as unknown as { default?: typeof Vapi }).default ?? Vapi

type CallStatus = 'agent_speaking' | 'lead_speaking' | 'thinking' | 'idle'
type AgentMode = 'deterministic' | 'llm'
type CallMode = 'demo' | 'interactive'
type StartMode = 'predefined' | 'ai_scripted' | 'ai_interactive'
type VapiVoiceStatus = 'idle' | 'connecting' | 'connected' | 'speaking'

type TranscriptEntry = {
  speaker: 'agent' | 'lead'
  name: string
  message: string
}

type Lead = {
  id: string
  scenario: string
  name: string
  title: string
  company: string
  industry: string
  companySize: string
  currentTools: string[]
  painHint: string
  discussionTopic: string
  previousInteraction: string
  workEmail: string
}

type AgentProfile = {
  name: string
  role: string
  company: string
  shortProfile: string
}

type CallResult = {
  callId: string
  mode: string
  agent: {
    name: string
    role: string
    company: string
  }
  lead: Lead
  transcript: TranscriptEntry[]
  summary: {
    painPoints: string[]
    objections: string[]
    interestLevel: string
    meetingStatus: string
    recommendedNextAction: string
    shortSummaryForSales: string
  }
  classification: {
    outcome: string
    reason: string
  }
  intentDetections?: Array<{
    intent: string
    objectionType: string
    nextAgentMove: string
    reasoning: string
  }>
  toolCalls: Array<{
    name: string
  }>
}

type SpeechRecognitionAlternativeLike = {
  transcript: string
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternativeLike
}

type SpeechRecognitionResultListLike = {
  length: number
  [index: number]: SpeechRecognitionResultLike
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

type SpeechRecognitionErrorEventLike = {
  error: string
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onstart: (() => void) | null
  abort: () => void
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

const carlaImageSrc = '/Gemini_Generated_Image_l56rq4l56rq4l56r.png'
const frontendAgentName = 'Alexy'
const voiceSubmitDelayMs = 4000

const displayAgentMessage = (message: string) =>
  message.replace(/\bCarla\b/gi, frontendAgentName)

const toolLabels: Record<string, string> = {
  getLeadContext: 'CRM loaded',
  checkCalendarAvailability: 'Calendar checked',
  bookMeeting: 'Meeting booked',
  saveCallSummary: 'Summary saved',
}

const formatOutcome = (value: string) =>
  value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

const finalOutcomes = new Set([
  'meeting_booked',
])

const maxInteractiveLeadTurns = 6

const startModeConfig: Record<StartMode, { title: string; description: string; agentMode: AgentMode; callMode: CallMode }> = {
  predefined: {
    title: 'Predefined',
    description: 'Fixed lead responses (no AI)',
    agentMode: 'deterministic',
    callMode: 'demo',
  },
  ai_scripted: {
    title: 'AI (Scripted)',
    description: 'AI agent + scripted lead',
    agentMode: 'llm',
    callMode: 'demo',
  },
  ai_interactive: {
    title: 'AI (Interactive)',
    description: 'AI agent + live conversation',
    agentMode: 'llm',
    callMode: 'interactive',
  },
}

const shouldEndForSchedulingEmail = (call: CallResult) =>
  call.summary.recommendedNextAction.toLowerCase().includes('email available meeting time slots')

const friendlyError = (message: string) => {
  if (message.includes('GROQ_API_KEY')) {
    return 'LLM and Interactive Mode need a valid GROQ_API_KEY in .env. Restart the backend after configuring it.'
  }

  return message
}

const fetchJsonWithRetry = async <T,>(url: string, attempts = 8): Promise<T> => {
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
      }

      return (await response.json()) as T
    } catch (caughtError) {
      lastError = caughtError
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed')
}

function App() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [selectedLeadId, setSelectedLeadId] = useState('')
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null)
  const [call, setCall] = useState<CallResult | null>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  const [status, setStatus] = useState<CallStatus>('idle')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isStartModalOpen, setIsStartModalOpen] = useState(false)
  const [selectedStartMode, setSelectedStartMode] = useState<StartMode>('predefined')
  const [activeStartMode, setActiveStartMode] = useState<StartMode | null>(null)
  const [activeCallMode, setActiveCallMode] = useState<CallMode | null>(null)
  const [leadReply, setLeadReply] = useState('')
  const [isVoiceListening, setIsVoiceListening] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [vapiVoiceStatus, setVapiVoiceStatus] = useState<VapiVoiceStatus>('idle')
  const [vapiVoiceError, setVapiVoiceError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const vapiRef = useRef<Vapi | null>(null)
  const pendingVoiceReplyRef = useRef('')
  const voiceSubmitTimerRef = useRef<number | null>(null)
  const speakLatestAgentTurnRef = useRef<() => void>(() => {})
  const startVapiVoiceRef = useRef<() => Promise<void>>(async () => {})
  const vapiSpokenAgentTurnRef = useRef(-1)
  const vapiCallStartedRef = useRef(false)
  const vapiStartAttemptedRef = useRef(false)
  const pendingVapiAgentTurnRef = useRef<{
    endCallAfterSpoken: boolean
    index: number
    message: string
  } | null>(null)
  const scriptedLeadRevealTimerRef = useRef<number | null>(null)
  const vapiPublicKey = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined
  const vapiAssistantId = import.meta.env.VITE_VAPI_ASSISTANT_ID as string | undefined
  const vapiVoiceConfigured = Boolean(
    vapiPublicKey &&
      vapiPublicKey !== 'replace_me' &&
      vapiAssistantId &&
      vapiAssistantId !== 'replace_me',
  )
  const vapiVoiceActive = vapiVoiceStatus === 'connected' || vapiVoiceStatus === 'speaking'
  const activeModeUsesVapiVoice =
    vapiVoiceConfigured && (activeStartMode === 'ai_scripted' || activeStartMode === 'ai_interactive')

  const visibleTranscript = useMemo(() => {
    if (!call) {
      return []
    }

    return activeCallMode === 'interactive'
      ? call.transcript
      : call.transcript.slice(0, visibleCount)
  }, [activeCallMode, call, visibleCount])

  const selectedLead = call?.lead ?? leads.find((lead) => lead.id === selectedLeadId) ?? null
  const displayAgent = {
    ...(call?.agent ?? agentProfile),
    name: frontendAgentName,
    role: 'AI SDR Agent',
  }
  const agentName = displayAgent.name
  const agentRole = displayAgent.role
  const latestIntent = call?.intentDetections?.[call.intentDetections.length - 1]
  const serverSignals = useMemo(() => {
    const signals = call?.toolCalls.map((toolCall) => toolLabels[toolCall.name] ?? toolCall.name) ?? []
    const checkedCalendar = call?.toolCalls.some((toolCall) => toolCall.name === 'checkCalendarAvailability')

    if (latestIntent) {
      signals.push(`Intent: ${formatOutcome(latestIntent.intent)}`)
      if (latestIntent.objectionType && latestIntent.objectionType !== 'none') {
        signals.push(`Objection: ${formatOutcome(latestIntent.objectionType)}`)
      }
      signals.push(
        latestIntent.nextAgentMove === 'offer_meeting' && !checkedCalendar
          ? 'Next: Continue discovery'
          : `Next: ${formatOutcome(latestIntent.nextAgentMove)}`,
      )
    }

    return signals.slice(-6)
  }, [call?.toolCalls, latestIntent])

  const statusText: Record<CallStatus, string> = {
    agent_speaking: `${agentName} speaking${vapiVoiceActive ? ' via Vapi' : ''}`,
    lead_speaking: 'Listening to lead',
    thinking: 'Thinking',
    idle: '',
  }

  const leadTurnCount = call?.transcript.filter((entry) => entry.speaker === 'lead').length ?? 0
  const callIsComplete = Boolean(
    call &&
      (call.summary.meetingStatus === 'booked' ||
        (activeCallMode === 'interactive'
          ? leadTurnCount >= maxInteractiveLeadTurns || shouldEndForSchedulingEmail(call)
          : finalOutcomes.has(call.classification.outcome))),
  )
  const callInProgress =
    activeCallMode === 'interactive'
      ? Boolean(call) && !callIsComplete
      : call
        ? visibleCount < call.transcript.length
        : false
  const speechRecognitionSupported =
    typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    const loadAgentProfile = async () => {
      try {
        const body = await fetchJsonWithRetry<{ agent: AgentProfile }>(
          'http://localhost:3001/api/agent',
        )
        setAgentProfile(body.agent)
      } catch {
        setAgentProfile(null)
      }
    }

    void loadAgentProfile()
  }, [])

  useEffect(() => {
    const loadLeads = async () => {
      try {
        const body = await fetchJsonWithRetry<{ leads: Lead[] }>(
          'http://localhost:3001/api/leads',
        )
        setLeads(body.leads)
        setSelectedLeadId((current) => current || body.leads[0]?.id || '')
      } catch {
        setLeads([])
      }
    }

    void loadLeads()
  }, [])

  useEffect(() => {
    if (!call || visibleCount >= call.transcript.length) {
      if (call && visibleCount === call.transcript.length) {
        setStatus('idle')
      }
      return
    }

    if (activeStartMode === 'ai_scripted' && activeModeUsesVapiVoice) {
      return
    }

    const nextEntry = call.transcript[visibleCount]
    setStatus(nextEntry.speaker === 'agent' ? 'agent_speaking' : 'lead_speaking')

    const timer = window.setTimeout(() => {
      setVisibleCount((current) => current + 1)
      setStatus('thinking')
    }, 750)

    return () => window.clearTimeout(timer)
  }, [activeModeUsesVapiVoice, activeStartMode, call, visibleCount])

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      vapiRef.current?.removeAllListeners()
      void vapiRef.current?.stop()
      if (voiceSubmitTimerRef.current) {
        window.clearTimeout(voiceSubmitTimerRef.current)
      }
      if (scriptedLeadRevealTimerRef.current) {
        window.clearTimeout(scriptedLeadRevealTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (
      activeStartMode === 'ai_scripted' ||
      activeCallMode !== 'interactive' ||
      !call ||
      !vapiRef.current ||
      !vapiVoiceActive
    ) {
      return
    }

    const latestAgentTurn = [...call.transcript]
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(({ entry }) => entry.speaker === 'agent')

    if (!latestAgentTurn || latestAgentTurn.index <= vapiSpokenAgentTurnRef.current) {
      return
    }

    speakLatestAgentTurnRef.current()
  }, [activeCallMode, activeStartMode, call, callIsComplete, vapiVoiceActive])

  useEffect(() => {
    if (
      activeStartMode !== 'ai_scripted' ||
      !call ||
      !vapiRef.current ||
      !vapiVoiceActive ||
      visibleCount >= call.transcript.length
    ) {
      return
    }

    const nextEntry = call.transcript[visibleCount]

    if (nextEntry.speaker !== 'agent' || visibleCount <= vapiSpokenAgentTurnRef.current) {
      return
    }

    queueVapiAgentTurn({
      endCallAfterSpoken: visibleCount === call.transcript.length - 1,
      index: visibleCount,
      message: displayAgentMessage(nextEntry.message),
    })
  }, [activeStartMode, call, vapiVoiceActive, visibleCount])

  useEffect(() => {
    if (
      !(activeStartMode === 'ai_scripted' || activeCallMode === 'interactive') ||
      !call ||
      (activeCallMode === 'interactive' && callIsComplete) ||
      !activeModeUsesVapiVoice ||
      vapiVoiceStatus !== 'idle' ||
      vapiStartAttemptedRef.current
    ) {
      return
    }

    void startVapiVoiceRef.current()
  }, [activeCallMode, activeModeUsesVapiVoice, activeStartMode, call, callIsComplete, vapiVoiceStatus])

  const beginCall = async () => {
    if (!selectedLeadId) {
      setError(`Choose who ${frontendAgentName} is calling before starting.`)
      return
    }

    const startMode = startModeConfig[selectedStartMode]
    const callMode = startMode.callMode
    const startModeKey = selectedStartMode
    setIsLoading(true)
    setError(null)
    setCall(null)
    setVisibleCount(0)
    setStatus('thinking')
    setActiveStartMode(startModeKey)
    setActiveCallMode(callMode)
    setIsStartModalOpen(false)
    setLeadReply('')
    setVoiceError(null)
    setVapiVoiceError(null)
    if ((startModeKey === 'ai_scripted' || startModeKey === 'ai_interactive') && !vapiVoiceConfigured) {
      setVapiVoiceError('Vapi voice is not configured. Add VITE_VAPI_PUBLIC_KEY and VITE_VAPI_ASSISTANT_ID to .env, then restart the frontend.')
    }
    setIsVoiceListening(false)
    pendingVoiceReplyRef.current = ''
    if (voiceSubmitTimerRef.current) {
      window.clearTimeout(voiceSubmitTimerRef.current)
      voiceSubmitTimerRef.current = null
    }
    if (scriptedLeadRevealTimerRef.current) {
      window.clearTimeout(scriptedLeadRevealTimerRef.current)
      scriptedLeadRevealTimerRef.current = null
    }
    vapiSpokenAgentTurnRef.current = -1
    vapiCallStartedRef.current = false
    vapiStartAttemptedRef.current = false
    pendingVapiAgentTurnRef.current = null
    recognitionRef.current?.abort()
    await stopVapiVoice()

    try {
      const endpoint =
        callMode === 'interactive'
          ? 'http://localhost:3001/api/calls/interactive/start'
          : 'http://localhost:3001/api/calls'
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedLeadId, mode: startMode.agentMode }),
      })

      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error ?? 'Call request failed')
      }

      const body = (await response.json()) as { call: CallResult }
      setCall(body.call)
      setVisibleCount(0)
      setStatus(callMode === 'interactive' ? 'idle' : 'thinking')
    } catch (caughtError) {
      setStatus('idle')
      setActiveStartMode(null)
      setActiveCallMode(null)
      setError(
        caughtError instanceof Error
          ? `Could not start the call. ${friendlyError(caughtError.message)}`
          : 'Could not start the call. Please make sure the backend is running.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  const endCall = () => {
    recognitionRef.current?.abort()
    void stopVapiVoice()
    setStatus('idle')
    setVisibleCount(call?.transcript.length ?? 0)
    setActiveStartMode(null)
    setActiveCallMode(null)
    setLeadReply('')
    setIsVoiceListening(false)
    setVoiceError(null)
    setVapiVoiceError(null)
    pendingVoiceReplyRef.current = ''
    vapiCallStartedRef.current = false
    vapiStartAttemptedRef.current = false
    pendingVapiAgentTurnRef.current = null
    if (voiceSubmitTimerRef.current) {
      window.clearTimeout(voiceSubmitTimerRef.current)
      voiceSubmitTimerRef.current = null
    }
    if (scriptedLeadRevealTimerRef.current) {
      window.clearTimeout(scriptedLeadRevealTimerRef.current)
      scriptedLeadRevealTimerRef.current = null
    }
  }

  const sendLeadReply = async (reply: string) => {
    const cleanedReply = reply.trim()

    if (!call || !cleanedReply) {
      return
    }

    setIsLoading(true)
    setError(null)
    setVoiceError(null)
    setStatus('thinking')

    try {
      const response = await fetch('http://localhost:3001/api/calls/interactive/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: call.callId,
          leadId: selectedLeadId,
          transcript: call.transcript,
          leadReply: cleanedReply,
        }),
      })

      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        throw new Error(body.error ?? 'Lead reply failed')
      }

      const body = (await response.json()) as { call: CallResult }
      setCall(body.call)
      setVisibleCount(body.call.transcript.length)
      setLeadReply('')
      setStatus('idle')
    } catch (caughtError) {
      setStatus('idle')
      setError(
        caughtError instanceof Error
          ? `Could not send the lead reply. ${friendlyError(caughtError.message)}`
          : 'Could not send the lead reply. Please make sure the backend is running.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  const submitLeadReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await sendLeadReply(leadReply)
  }

  const sendPendingVoiceReply = () => {
    const reply = pendingVoiceReplyRef.current.trim()

    if (!reply) {
      return
    }

    if (voiceSubmitTimerRef.current) {
      window.clearTimeout(voiceSubmitTimerRef.current)
      voiceSubmitTimerRef.current = null
    }

    recognitionRef.current?.stop()
    recognitionRef.current = null
    pendingVoiceReplyRef.current = ''
    setIsVoiceListening(false)
    void sendLeadReply(reply)
  }

  const scheduleVoiceReplySubmit = (delay = voiceSubmitDelayMs) => {
    if (voiceSubmitTimerRef.current) {
      window.clearTimeout(voiceSubmitTimerRef.current)
    }

    voiceSubmitTimerRef.current = window.setTimeout(() => {
      sendPendingVoiceReply()
    }, delay)
  }

  const toggleVoiceCapture = () => {
    if (isVoiceListening) {
      sendPendingVoiceReply()
      recognitionRef.current?.stop()
      return
    }

    if (!call || isLoading || callIsComplete) {
      return
    }

    const SpeechRecognition =
      window.SpeechRecognition ?? window.webkitSpeechRecognition

    if (!SpeechRecognition) {
      setVoiceError('Speech recognition is not available in this browser. Use Chrome or Edge, or type the reply.')
      return
    }

    const recognition = new SpeechRecognition()
    pendingVoiceReplyRef.current = ''
    recognitionRef.current = recognition
    recognition.lang = 'en-US'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => {
      setLeadReply('')
      setVoiceError(null)
      setIsVoiceListening(true)
      setStatus('lead_speaking')
    }
    recognition.onerror = (event) => {
      setVoiceError(
        event.error === 'not-allowed'
          ? 'Microphone permission was blocked for this page.'
          : `Could not capture the lead voice: ${event.error}.`,
      )
    }
    recognition.onresult = (event) => {
      const existingFinalText = pendingVoiceReplyRef.current
      let finalText = ''
      let interimText = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0]?.transcript ?? ''

        if (result.isFinal) {
          finalText += transcript
        } else {
          interimText += transcript
        }
      }

      const combinedFinalText = `${existingFinalText} ${finalText}`.trim()
      const nextReply = `${combinedFinalText} ${interimText}`.trim()
      setLeadReply(nextReply)

      if (finalText.trim()) {
        pendingVoiceReplyRef.current = combinedFinalText
        scheduleVoiceReplySubmit()
      }
    }
    recognition.onend = () => {
      setIsVoiceListening(false)
      recognitionRef.current = null

      if (pendingVoiceReplyRef.current) {
        scheduleVoiceReplySubmit()
      }

      if (!pendingVoiceReplyRef.current && !isLoading && activeCallMode === 'interactive') {
        setStatus('idle')
      }
    }

    try {
      recognition.start()
    } catch (caughtError) {
      recognitionRef.current = null
      setIsVoiceListening(false)
      setVoiceError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not start microphone capture.',
      )
    }
  }

  const latestAgentTurn = () =>
    call?.transcript
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(({ entry }) => entry.speaker === 'agent')

  const dispatchQueuedVapiAgentTurn = (vapi: Vapi) => {
    const pendingTurn = pendingVapiAgentTurnRef.current

    if (!pendingTurn || !vapiCallStartedRef.current) {
      return
    }

    pendingVapiAgentTurnRef.current = null
    vapi.say(pendingTurn.message, pendingTurn.endCallAfterSpoken, false, true)
    vapiSpokenAgentTurnRef.current = pendingTurn.index
  }

  const queueVapiAgentTurn = (turn: { endCallAfterSpoken: boolean; index: number; message: string }) => {
    if (turn.index <= vapiSpokenAgentTurnRef.current) {
      return
    }

    pendingVapiAgentTurnRef.current = turn

    if (vapiRef.current) {
      dispatchQueuedVapiAgentTurn(vapiRef.current)
    }
  }

  const speakLatestAgentTurnWithVapi = () => {
    const currentAgentTurn = latestAgentTurn()

    if (!currentAgentTurn || currentAgentTurn.index <= vapiSpokenAgentTurnRef.current) {
      return
    }

    queueVapiAgentTurn({
      endCallAfterSpoken: callIsComplete,
      index: currentAgentTurn.index,
      message: displayAgentMessage(currentAgentTurn.entry.message),
    })
  }

  const revealScriptedLeadAfterAgent = (agentIndex: number) => {
    if (!call || activeStartMode !== 'ai_scripted') {
      return
    }

    const leadIndex = agentIndex + 1

    if (call.transcript[leadIndex]?.speaker !== 'lead') {
      setVisibleCount(Math.max(agentIndex + 1, visibleCount))
      setStatus('idle')
      return
    }

    if (scriptedLeadRevealTimerRef.current) {
      window.clearTimeout(scriptedLeadRevealTimerRef.current)
    }

    scriptedLeadRevealTimerRef.current = window.setTimeout(() => {
      setStatus('lead_speaking')
      setVisibleCount((current) => Math.max(current, leadIndex + 1))

      scriptedLeadRevealTimerRef.current = window.setTimeout(() => {
        setStatus('thinking')
      }, 700)
    }, 450)
  }

  const stopVapiVoice = async () => {
    const vapi = vapiRef.current

    if (!vapi) {
      vapiCallStartedRef.current = false
      pendingVapiAgentTurnRef.current = null
      setVapiVoiceStatus('idle')
      return
    }

    vapiRef.current = null
    vapiCallStartedRef.current = false
    pendingVapiAgentTurnRef.current = null
    vapi.removeAllListeners()

    try {
      await vapi.stop()
    } finally {
      setVapiVoiceStatus('idle')
    }
  }

  const startVapiVoice = async () => {
    if (!selectedLead) {
      setVapiVoiceError('Choose a lead before starting Vapi voice.')
      return
    }

    if (!vapiVoiceConfigured || !vapiPublicKey || !vapiAssistantId) {
      setVapiVoiceError('Add VITE_VAPI_PUBLIC_KEY and VITE_VAPI_ASSISTANT_ID to .env to use Vapi voice.')
      return
    }

    if (vapiRef.current || vapiVoiceStatus === 'connecting') {
      return
    }

    if (vapiStartAttemptedRef.current) return
    vapiStartAttemptedRef.current = true
    setVapiVoiceStatus('connecting')
    setVapiVoiceError(null)

    const vapi = new VapiClient(vapiPublicKey, undefined, undefined, { startAudioOff: true })
    vapiRef.current = vapi
    vapi.on('call-start', () => {
      vapiCallStartedRef.current = true
      setVapiVoiceStatus('connected')
      setStatus('idle')
      vapi.setMuted(true)
      if (activeStartMode !== 'ai_scripted') {
        speakLatestAgentTurnWithVapi()
        window.setTimeout(() => dispatchQueuedVapiAgentTurn(vapi), 250)
      }
    })
    vapi.on('call-end', () => {
      vapiRef.current = null
      vapiCallStartedRef.current = false
      pendingVapiAgentTurnRef.current = null
      setVapiVoiceStatus('idle')
    })
    vapi.on('speech-start', () => {
      setVapiVoiceStatus('speaking')
      setStatus('agent_speaking')
      if (activeStartMode === 'ai_scripted') {
        setVisibleCount((current) => Math.max(current, vapiSpokenAgentTurnRef.current + 1))
      }
    })
    vapi.on('speech-end', () => {
      setVapiVoiceStatus('connected')
      if (activeStartMode === 'ai_scripted') {
        revealScriptedLeadAfterAgent(vapiSpokenAgentTurnRef.current)
        return
      }

      if (!isVoiceListening && activeCallMode === 'interactive') {
        setStatus('idle')
      }
    })
    vapi.on('error', (caughtError) => {
      setVapiVoiceError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Vapi voice failed. Check the public key, assistant id, and dashboard endpoint.',
      )
      setVapiVoiceStatus('idle')
      setVisibleCount(call?.transcript.length ?? 0)
    })

    try {
      await Promise.race([
        vapi.start(vapiAssistantId, {
          firstMessageMode: 'assistant-waits-for-user',
          variableValues: {
            leadId: selectedLead.id,
            leadName: selectedLead.name,
            company: selectedLead.company,
          },
          metadata: {
            leadId: selectedLead.id,
            source: 'ai-sdr',
            backendBrain: true,
            voiceLayerOnly: true,
          },
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(
            () => reject(new Error('Vapi voice connection timed out. Check the assistant id, public key, and Custom LLM URL.')),
            15000,
          )
        }),
      ])

      if (vapiCallStartedRef.current && activeStartMode !== 'ai_scripted') {
        speakLatestAgentTurnWithVapi()
      }
    } catch (caughtError) {
      vapiRef.current = null
      vapiCallStartedRef.current = false
      pendingVapiAgentTurnRef.current = null
      vapi.removeAllListeners()
      void vapi.stop()
      setVapiVoiceStatus('idle')
      setVisibleCount(call?.transcript.length ?? 0)
      setVapiVoiceError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Could not start the Vapi web call.',
      )
    }
  }

  speakLatestAgentTurnRef.current = speakLatestAgentTurnWithVapi
  startVapiVoiceRef.current = startVapiVoice

  return (
    <main className="call-shell">
      <aside className="server-panel" aria-label="Server side signals">
        <div className="server-heading">Server side</div>
        <div className="server-list">
          {serverSignals.length ? (
            serverSignals.map((signal, index) => <span key={`${signal}-${index}`}>{signal}</span>)
          ) : (
            <p>Waiting for backend events.</p>
          )}
        </div>
      </aside>

      <aside className="transcript-panel" aria-label="Call transcript">
        <div className="panel-heading">
          <span>Transcript</span>
          <strong>
            {visibleTranscript.length}
            {call ? `/${call.transcript.length}` : ''}
          </strong>
        </div>

        <div className="transcript-list">
          {isLoading && visibleTranscript.length === 0 ? (
            <p className="empty-transcript">Loading...</p>
          ) : (activeStartMode === 'ai_scripted' || activeCallMode === 'interactive') &&
            call &&
            visibleTranscript.length === 0 &&
            vapiVoiceStatus === 'connecting' ? (
            <p className="empty-transcript">Connecting voice...</p>
          ) : visibleTranscript.length === 0 ? (
            <p className="empty-transcript">Start a call to see the conversation.</p>
          ) : (
            visibleTranscript.map((entry, index) => (
              <div
                className={`bubble-row bubble-row-${entry.speaker}`}
                key={`${entry.speaker}-${index}`}
              >
                <div className={`bubble bubble-${entry.speaker}`}>
                  <span>{entry.speaker === 'agent' ? agentName : entry.name}</span>
                  <p>{entry.speaker === 'agent' ? displayAgentMessage(entry.message) : entry.message}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="agent-stage" aria-label="Call controls">
        <div className="lead-controls">
          <label htmlFor="lead">Who is {agentName} calling?</label>
          <select
            id="lead"
            value={selectedLeadId}
            onChange={(event) => setSelectedLeadId(event.target.value)}
            disabled={isLoading || callInProgress}
          >
            {leads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.name} - {lead.company}
              </option>
            ))}
          </select>
        </div>

        <div className={`agent-presence status-${status}`}>
          <div className="pulse-ring" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div className="agent-portrait">
            <img src={carlaImageSrc} alt={agentName} />
          </div>
          {isVoiceListening ? (
            <div className="lead-listening-wave" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
              <span></span>
            </div>
          ) : null}
        </div>

        <p className="status-label">
          {isLoading
            ? (call ? 'Loading next turn' : `${agentName} is preparing the call`)
            : vapiVoiceStatus === 'connecting'
              ? 'Connecting Vapi voice'
              : statusText[status]}
        </p>
        <h1>{agentName}</h1>
        <p className="agent-subtitle">
          {agentRole}
        </p>

        {selectedLead ? (
          <div className="lead-context">
            <span>{call ? 'Current call' : 'Selected lead'}</span>
            <strong>
              {selectedLead.name}, {selectedLead.title}
            </strong>
            <p>
              {selectedLead.company} | {selectedLead.industry} | {selectedLead.companySize}
            </p>
            <p>{selectedLead.discussionTopic}</p>
            <div className="lead-card-meta">
              <span>{selectedLead.currentTools.join(', ')}</span>
              <span>{selectedLead.previousInteraction}</span>
            </div>
          </div>
        ) : null}

        <button
          className="call-action"
          type="button"
          onClick={callInProgress ? endCall : () => setIsStartModalOpen(true)}
          disabled={isLoading || (!callInProgress && !selectedLeadId)}
        >
          {isLoading ? 'Loading...' : callInProgress ? 'End call' : 'Start call'}
        </button>

        {activeCallMode === 'interactive' && call && !callIsComplete ? (
          <form className="lead-reply-form" onSubmit={submitLeadReply}>
            <label htmlFor="leadReply">Lead reply</label>
            <textarea
              id="leadReply"
              value={leadReply}
              onChange={(event) => setLeadReply(event.target.value)}
              placeholder={isVoiceListening ? 'Listening...' : 'Type what the lead says next...'}
              disabled={isLoading || isVoiceListening}
              rows={3}
            />
            <div className="lead-reply-actions">
              <button
                className={`mic-button${isVoiceListening ? ' is-listening' : ''}`}
                type="button"
                onClick={toggleVoiceCapture}
                disabled={isLoading || !speechRecognitionSupported}
                aria-label={isVoiceListening ? 'Stop listening to lead' : 'Listen to lead'}
                title={isVoiceListening ? 'Stop listening' : 'Listen to lead'}
              >
                <span className="mic-glyph" aria-hidden="true">
                  <span></span>
                </span>
                <span>{isVoiceListening ? 'Listening' : 'Mic'}</span>
              </button>
              <button type="submit" disabled={isLoading || isVoiceListening || !leadReply.trim()}>
                Send reply
              </button>
            </div>
            {voiceError ? <p className="voice-error">{voiceError}</p> : null}
            {vapiVoiceError ? <p className="voice-error">{vapiVoiceError}</p> : null}
          </form>
        ) : null}

        {call &&
        (activeCallMode === 'interactive'
          ? callIsComplete
          : visibleCount === call.transcript.length) ? (
          <div className="demo-outcome" aria-label="Call outcome">
            <div className="summary-heading">
              <span>Call outcome</span>
              <strong>{formatOutcome(call.classification.outcome)}</strong>
            </div>
            <dl>
              <div>
                <dt>Interest</dt>
                <dd>{formatOutcome(call.summary.interestLevel)}</dd>
              </div>
              <div>
                <dt>Meeting</dt>
                <dd>{formatOutcome(call.summary.meetingStatus)}</dd>
              </div>
              <div>
                <dt>Next action</dt>
                <dd>{call.summary.recommendedNextAction}</dd>
              </div>
              <div>
                <dt>Why</dt>
                <dd>{call.classification.reason}</dd>
              </div>
              <div>
                <dt>Call note</dt>
                <dd>{call.summary.shortSummaryForSales}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {error ? <p className="error-message">{error}</p> : null}
        {vapiVoiceError && activeCallMode !== 'interactive' ? (
          <p className="voice-error">{vapiVoiceError}</p>
        ) : null}
      </section>

      {isStartModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="start-modal" role="dialog" aria-modal="true" aria-labelledby="startModalTitle">
            <div className="modal-heading">
              <h2 id="startModalTitle">Start call</h2>
              <button type="button" onClick={() => setIsStartModalOpen(false)}>
                Close
              </button>
            </div>

            <div className="mode-field mode-options">
              {(Object.entries(startModeConfig) as Array<[StartMode, (typeof startModeConfig)[StartMode]]>).map(
                ([mode, config]) => (
                  <label className="mode-option" key={mode}>
                    <input
                      type="radio"
                      name="startMode"
                      value={mode}
                      checked={selectedStartMode === mode}
                      onChange={() => setSelectedStartMode(mode)}
                    />
                    <span>{config.title}</span>
                    <small>{config.description}</small>
                  </label>
                ),
              )}
            </div>

            <button className="modal-start" type="button" onClick={beginCall} disabled={isLoading}>
              Start
            </button>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
