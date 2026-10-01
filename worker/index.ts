import { DurableObject } from 'cloudflare:workers'

type RoomState = {
  count: number
  dice: number[]
  history: number[]
  diceHistory?: number[][]
  strength: number
  revision: number
  turnMode?: boolean
  turnOwner?: string | null
}

type RoomAction =
  | { type: 'roll'; clientId?: string }
  | { type: 'changeCount'; count: number }
  | { type: 'setStrength'; strength: number }
  | { type: 'undo'; clientId: string }
  | { type: 'reset' }
  | { type: 'setTurnMode'; enabled: boolean }
  | { type: 'endTurn'; clientId: string }

interface Env {
  ASSETS: Fetcher
  DICE_ROOMS: DurableObjectNamespace<DiceRoom>
}

const initialState = (): RoomState => ({
  count: 2,
  dice: [3, 4],
  history: [],
  diceHistory: [],
  strength: 65,
  revision: 0,
  turnMode: false,
  turnOwner: null,
})

function distribution(count: number) {
  let totals = new Map<number, number>([[0, 1]])
  for (let die = 0; die < count; die++) {
    const next = new Map<number, number>()
    for (const [sum, ways] of totals) {
      for (let face = 1; face <= 6; face++) next.set(sum + face, (next.get(sum + face) ?? 0) + ways)
    }
    totals = next
  }
  return totals
}

function rollDice(state: RoomState): number[] {
  const totals = distribution(state.count)
  const rolls = state.history.length
  const outcomes = [...totals].map(([sum, ways]) => {
    const base = ways / 6 ** state.count
    const actual = state.history.filter(value => value === sum).length
    const expected = base * rolls
    return { sum, weight: base * Math.exp((state.strength / 100) * (expected - actual) / Math.sqrt(expected + 1)) }
  })
  let random = Math.random() * outcomes.reduce((total, outcome) => total + outcome.weight, 0)
  const chosen = outcomes.find(outcome => (random -= outcome.weight) <= 0) ?? outcomes.at(-1)!

  // Pick uniformly among all face combinations that produce the selected total.
  const dice: number[] = []
  let remaining = chosen.sum
  for (let index = 0; index < state.count; index++) {
    const weightedFaces: Array<{ face: number; ways: number }> = []
    const diceLeft = state.count - index - 1
    const remainingDistribution = distribution(diceLeft)
    for (let face = 1; face <= 6; face++) {
      const rest = remaining - face
      const ways = remainingDistribution.get(rest) ?? 0
      if (ways) weightedFaces.push({ face, ways })
    }
    let choice = Math.random() * weightedFaces.reduce((total, option) => total + option.ways, 0)
    const face = (weightedFaces.find(option => (choice -= option.ways) <= 0) ?? weightedFaces.at(-1)!).face
    dice.push(face)
    remaining -= face
  }
  return dice
}

export class DiceRoom extends DurableObject<Env> {
  private roomState: RoomState | undefined

  private async getState() {
    this.roomState ??= (await this.ctx.storage.get<RoomState>('state')) ?? initialState()
    return this.roomState
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].send(JSON.stringify({ type: 'state', state: await this.getState() }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return
    let action: RoomAction
    try { action = JSON.parse(message) as RoomAction } catch { return }
    const state = await this.getState()

    if (action.type === 'roll') {
      if (state.turnMode && (!action.clientId || (state.turnOwner && state.turnOwner !== action.clientId))) {
        _socket.send(JSON.stringify({ type: 'state', state }))
        return
      }
      const dice = rollDice(state)
      this.roomState = { ...state, dice, diceHistory: [...(state.diceHistory ?? []), state.dice], history: [...state.history, dice.reduce((a, b) => a + b, 0)], turnOwner: state.turnMode ? action.clientId! : null, revision: state.revision + 1 }
    } else if (action.type === 'undo' && state.history.length && (!state.turnMode || !state.turnOwner || state.turnOwner === action.clientId)) {
      const diceHistory = state.diceHistory ?? []
      this.roomState = { ...state, dice: diceHistory.at(-1) ?? state.dice, diceHistory: diceHistory.slice(0, -1), history: state.history.slice(0, -1), revision: state.revision + 1 }
    } else if (action.type === 'changeCount' && Number.isInteger(action.count) && action.count >= 1 && action.count <= 6) {
      this.roomState = { ...state, count: action.count, dice: Array.from({ length: action.count }, () => Math.ceil(Math.random() * 6)), history: [], diceHistory: [], turnOwner: null, revision: state.revision + 1 }
    } else if (action.type === 'setStrength' && Number.isFinite(action.strength) && action.strength >= 0 && action.strength <= 100) {
      this.roomState = { ...state, strength: action.strength, revision: state.revision + 1 }
    } else if (action.type === 'reset') {
      this.roomState = { ...state, history: [], diceHistory: [], turnOwner: null, revision: state.revision + 1 }
    } else if (action.type === 'setTurnMode' && typeof action.enabled === 'boolean') {
      this.roomState = { ...state, turnMode: action.enabled, turnOwner: null, revision: state.revision + 1 }
    } else if (action.type === 'endTurn' && state.turnMode && state.turnOwner === action.clientId) {
      this.roomState = { ...state, turnOwner: null, revision: state.revision + 1 }
    } else return

    await this.ctx.storage.put('state', this.roomState)
    const payload = JSON.stringify({ type: 'state', state: this.roomState })
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(payload) } catch { socket.close(1011, 'Broadcast failed') }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/room') {
      const room = url.searchParams.get('room')?.trim()
      if (!room || !/^\d{6}$/.test(room)) return new Response('Invalid room', { status: 400 })
      return env.DICE_ROOMS.get(env.DICE_ROOMS.idFromName(room)).fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
