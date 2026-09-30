import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const PIPS: Record<number, number[]> = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] }
type RoomState = { count:number; dice:number[]; history:number[]; diceHistory?:number[][]; strength:number; revision:number; turnMode?:boolean; turnOwner?:string|null }
type RoomAction = {type:'roll';clientId:string} | {type:'undo';clientId:string} | {type:'changeCount';count:number} | {type:'setStrength';strength:number} | {type:'reset'} | {type:'setTurnMode';enabled:boolean} | {type:'endTurn';clientId:string}

function getRoomId() {
  const url = new URL(window.location.href)
  let room = url.searchParams.get('room')?.replace(/[^\w-]/g,'').slice(0,80)
  if (!room) {
    room = crypto.randomUUID().replaceAll('-','').slice(0,12)
    url.searchParams.set('room',room)
    history.replaceState(null,'',url)
  }
  return room
}

function getClientId() {
  const key='balance-dice-client-id'
  let id=localStorage.getItem(key)
  if(!id){id=crypto.randomUUID();localStorage.setItem(key,id)}
  return id
}

function makeDistribution(count: number) {
  let combos: number[][] = [[]]
  for (let i=0; i<count; i++) combos = combos.flatMap(c => [1,2,3,4,5,6].map(n => [...c,n]))
  const map = new Map<number, number[][]>()
  combos.forEach(c => { const sum=c.reduce((a,b)=>a+b,0); map.set(sum,[...(map.get(sum)??[]),c]) })
  return map
}

function Die({value, rolling}:{value:number; rolling:boolean}) {
  return <div className={`die ${rolling?'rolling':''}`} aria-label={`${value}の目`}>
    {Array.from({length:9},(_,i)=><i key={i} className={PIPS[value].includes(i)?'pip on':'pip'}/>) }
  </div>
}

export default function App() {
  const [roomId]=useState(getRoomId), [clientId]=useState(getClientId), [state,setState]=useState<RoomState|null>(null)
  const [connection,setConnection]=useState<'connecting'|'connected'|'offline'>('connecting')
  const [rolling,setRolling]=useState(false), socketRef=useRef<WebSocket|null>(null), reconnectRef=useRef<number>(0), rollLockRef=useRef(false), rollTimeoutRef=useRef<number>(0)
  const {count=2,dice=[3,4],history=[],strength=65,turnMode=false,turnOwner=null}=state??{}
  const ownsTurn=turnOwner===clientId, turnLocked=turnMode&&Boolean(turnOwner)&&!ownsTurn
  const send=useCallback((action:RoomAction)=>{
    if(socketRef.current?.readyState!==WebSocket.OPEN)return false
    socketRef.current.send(JSON.stringify(action))
    if(action.type==='roll')setRolling(true)
    return true
  },[])

  useEffect(()=>{
    let stopped=false, socket:WebSocket|undefined
    const connect=()=>{
      if(stopped)return
      setConnection('connecting')
      const protocol=location.protocol==='https:'?'wss:':'ws:'
      socket=new WebSocket(`${protocol}//${location.host}/api/room?room=${encodeURIComponent(roomId)}`)
      socketRef.current=socket
      socket.onopen=()=>setConnection('connected')
      socket.onmessage=event=>{
        try {
          const message=JSON.parse(event.data) as {type:string;state:RoomState}
          if(message.type==='state')setState(previous=>{
            if(previous&&message.state.history.length>previous.history.length)setRolling(true)
            return message.state
          })
          clearTimeout(rollTimeoutRef.current)
          window.setTimeout(()=>{setRolling(false);rollLockRef.current=false},420)
        } catch { /* Ignore malformed server messages. */ }
      }
      socket.onclose=()=>{
        if(stopped)return
        rollLockRef.current=false
        clearTimeout(rollTimeoutRef.current)
        setRolling(false)
        setConnection('offline')
        reconnectRef.current=window.setTimeout(connect,1500)
      }
    }
    connect()
    return()=>{stopped=true;clearTimeout(reconnectRef.current);clearTimeout(rollTimeoutRef.current);socket?.close()}
  },[roomId])
  const distribution=useMemo(()=>makeDistribution(count),[count])
  const stats=useMemo(()=>{
    const rolls=history.length, total=6**count
    const rows=[...distribution].map(([sum,combos])=>{
      const base=combos.length/total, actual=history.filter(v=>v===sum).length, expected=base*rolls
      const adjusted=base*Math.exp((strength/100)*(expected-actual)/Math.sqrt(expected+1))
      return {sum,base,adjusted,actual:rolls ? actual/rolls : 0,actualCount:actual}
    })
    const weight=rows.reduce((a,r)=>a+r.adjusted,0)
    return rows.map(r=>({...r,adjusted:r.adjusted/weight}))
  },[count,distribution,history,strength])

  const roll=useCallback(()=>{
    if(rollLockRef.current||rolling||connection!=='connected'||turnLocked||(turnMode&&ownsTurn))return
    if(!send({type:'roll',clientId}))return
    rollLockRef.current=true
    clearTimeout(rollTimeoutRef.current)
    rollTimeoutRef.current=window.setTimeout(()=>{rollLockRef.current=false;setRolling(false)},3000)
  },[clientId,connection,ownsTurn,rolling,send,turnLocked,turnMode])
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      const target=e.target as HTMLElement
      const isEditing=['INPUT','TEXTAREA','SELECT','BUTTON'].includes(target.tagName)||target.isContentEditable
      if(e.code==='Space'&&!e.repeat&&!isEditing){e.preventDefault();roll()}
    }
    window.addEventListener('keydown',onKey)
    return()=>window.removeEventListener('keydown',onKey)
  },[roll])
  const changeCount=(n:number)=>send({type:'changeCount',count:n})
  const share=async()=>{await navigator.clipboard.writeText(location.href);setCopied(true);window.setTimeout(()=>setCopied(false),1600)}
  const [copied,setCopied]=useState(false)
  const max=Math.max(...stats.flatMap(r=>[r.adjusted,r.base])), sum=dice.reduce((a,b)=>a+b,0)
  const topThree=useMemo(()=>[...stats].sort((a,b)=>b.adjusted-a.adjusted||a.sum-b.sum).slice(0,3),[stats])

  return <main>
    <header><div className="brand"><b>⚄</b> Balance Dice</div><div className="room-tools"><span className={`status ${connection}`}>{connection==='connected'?'共有中':connection==='connecting'?'接続中':'再接続中'}</span><button className="share" onClick={share}>{copied?'コピーしました':'招待リンクをコピー'}</button><button className="reset" onClick={()=>send({type:'reset'})} disabled={!history.length}>↻　リセット</button></div></header>
    <section className="hero">
      <div className="dice-stage"><div className="dice-row">{dice.map((v,i)=><Die key={i} value={v} rolling={rolling}/>)}</div><div className="sum-display"><span>合計</span><strong>{sum}</strong></div></div>
      <div className="recent-results"><span>直近の結果</span>{history.length?<div>{history.slice(-3).reverse().map((value,index)=><b key={`${history.length-index}-${value}`} className={index===0?'latest':''}>{value}</b>)}</div>:<small>まだ結果がありません</small>}</div>
      <div className="roll-actions"><button className={`roll ${turnMode&&ownsTurn?'turn-end':''}`} onClick={turnMode&&ownsTurn?()=>send({type:'endTurn',clientId}):roll} disabled={rolling||connection!=='connected'||turnLocked}><span>{turnMode&&ownsTurn?'✓':'⚄'}</span>{connection!=='connected'?'ルームに接続中…':turnLocked?'他の人のターンです':rolling?'抽選中…':turnMode&&ownsTurn?'ターン終了':'サイコロを振る'}</button><button className="undo" onClick={()=>send({type:'undo',clientId})} disabled={rolling||!history.length||turnLocked} aria-label="直前の結果を取り消す">↶　1回戻す</button></div><div className="shortcut">Room: {roomId} ・ Space キーでも振れます</div>
    </section>
    <section className="dashboard">
      <div className="chart-card card">
        <div className="chart-head"><h2>次回の確率</h2></div>
        <div className="chart-scroll"><div className={`chart ${stats.length>15?'dense':''}`}>
          <div className="grid"><span>20%</span><span>15%</span><span>10%</span><span>5%</span><span>0%</span></div>
          <div className="bars">{stats.map(r=>{const rank=topThree.findIndex(item=>item.sum===r.sum);return <div className="bar-group" key={r.sum} title={`${rank>=0?`Top ${rank+1}｜`:''}合計 ${r.sum}｜次回 ${(r.adjusted*100).toFixed(1)}%`}><em>{(r.adjusted*100).toFixed(1)}%</em><div className="track"><div className="base" style={{height:`${r.base/max*90}%`}}/><div className={`fill ${rank>=0?`rank-${rank+1}`:''}`} style={{height:`${r.adjusted/max*90}%`}}/></div><b>{r.sum}</b></div>})}</div>
        </div></div>
        <div className="chart-meta"><div className="legend"><span><i className="gold"/>Top 1</span><span><i className="silver"/>Top 2</span><span><i className="bronze"/>Top 3</span><span><i className="purple"/>補正後</span><span><i/>理論値</span></div></div>
      </div>
      <div className="controls card">
        <div><label>サイコロの個数</label><div className="stepper"><button disabled={count===1} onClick={()=>changeCount(count-1)}>−</button><strong>{count}</strong><span>個</span><button disabled={count===6} onClick={()=>changeCount(count+1)}>＋</button></div></div>
        <div className="divider"/>
        <div className="strength"><div className="label-row"><label>補正の強さ</label><b>{strength}%</b></div><input type="range" min="0" max="100" value={strength} onChange={e=>send({type:'setStrength',strength:+e.target.value})} style={{'--value':`${strength}%`} as React.CSSProperties}/><div className="range-label"><span>自然</span><span>強く補正</span></div></div>
        <div className="divider"/><div className="trials"><label>試行回数</label><strong>{history.length}<small> 回</small></strong></div>
      </div>
      <div className="turn-control card"><div><strong>ターン制モード</strong><p>振った人が「ターン終了」を押すまで、ほかの人は振れません。</p></div><label className="switch"><input type="checkbox" checked={turnMode} onChange={e=>send({type:'setTurnMode',enabled:e.target.checked})}/><span/></label></div>
    </section>
  </main>
}
