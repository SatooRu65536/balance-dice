import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const PIPS: Record<number, number[]> = { 1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8] }
type RoomState = { count:number; dice:number[]; history:number[]; strength:number; revision:number }
type RoomAction = {type:'roll'} | {type:'changeCount';count:number} | {type:'setStrength';strength:number} | {type:'reset'}

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
  const [roomId]=useState(getRoomId), [state,setState]=useState<RoomState|null>(null)
  const [connection,setConnection]=useState<'connecting'|'connected'|'offline'>('connecting')
  const [rolling,setRolling]=useState(false), socketRef=useRef<WebSocket|null>(null), reconnectRef=useRef<number>(0)
  const {count=2,dice=[3,4],history=[],strength=65}=state??{}
  const send=useCallback((action:RoomAction)=>{
    if(socketRef.current?.readyState!==WebSocket.OPEN)return
    socketRef.current.send(JSON.stringify(action))
    if(action.type==='roll')setRolling(true)
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
          window.setTimeout(()=>setRolling(false),420)
        } catch { /* Ignore malformed server messages. */ }
      }
      socket.onclose=()=>{
        if(stopped)return
        setConnection('offline')
        reconnectRef.current=window.setTimeout(connect,1500)
      }
    }
    connect()
    return()=>{stopped=true;clearTimeout(reconnectRef.current);socket?.close()}
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

  const roll=useCallback(()=>{if(!rolling&&connection==='connected')send({type:'roll'})},[connection,rolling,send])
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
  const max=Math.max(...stats.flatMap(r=>[r.adjusted,r.base,r.actual])), sum=dice.reduce((a,b)=>a+b,0)

  return <main>
    <header><div className="brand"><b>⚄</b> Balance Dice</div><div className="room-tools"><span className={`status ${connection}`}>{connection==='connected'?'共有中':connection==='connecting'?'接続中':'再接続中'}</span><button className="share" onClick={share}>{copied?'コピーしました':'招待リンクをコピー'}</button><button className="reset" onClick={()=>send({type:'reset'})} disabled={!history.length}>↻　リセット</button></div></header>
    <section className="hero">
      <div className="dice-stage"><div className="dice-row">{dice.map((v,i)=><Die key={i} value={v} rolling={rolling}/>)}</div><small>合計 <strong>{sum}</strong></small></div>
      <button className="roll" onClick={roll} disabled={rolling||connection!=='connected'}><span>⚄</span>{connection!=='connected'?'ルームに接続中…':rolling?'抽選中…':'サイコロを振る'}</button><div className="shortcut">Room: {roomId} ・ Space キーでも振れます</div>
    </section>
    <section className="dashboard">
      <div className="controls card">
        <div><label>サイコロの個数</label><div className="stepper"><button disabled={count===1} onClick={()=>changeCount(count-1)}>−</button><strong>{count}</strong><span>個</span><button disabled={count===6} onClick={()=>changeCount(count+1)}>＋</button></div></div>
        <div className="divider"/>
        <div className="strength"><div className="label-row"><label>補正の強さ</label><b>{strength}%</b></div><input type="range" min="0" max="100" value={strength} onChange={e=>send({type:'setStrength',strength:+e.target.value})} style={{'--value':`${strength}%`} as React.CSSProperties}/><div className="range-label"><span>自然</span><span>強く補正</span></div></div>
        <div className="divider"/><div className="trials"><label>試行回数</label><strong>{history.length}<small> 回</small></strong></div>
      </div>
      <div className="chart-card card">
        <div className="chart-head"><div><h2>確率とこれまでの結果</h2><p>次回の確率と、実際に出た合計値の割合を比較できます。</p></div><div className="legend"><span><i className="purple"/>補正後</span><span><i className="orange"/>実績</span><span><i/>理論値</span></div></div>
        <div className="chart-scroll"><div className="chart" style={{minWidth:Math.max(620,stats.length*58)}}>
          <div className="grid"><span>20%</span><span>15%</span><span>10%</span><span>5%</span><span>0%</span></div>
          <div className="bars">{stats.map(r=><div className="bar-group" key={r.sum} title={`合計 ${r.sum}｜補正後 ${(r.adjusted*100).toFixed(2)}%｜実績 ${(r.actual*100).toFixed(2)}%（${r.actualCount}回）`}><em>{(r.adjusted*100).toFixed(1)}%</em><div className="track"><div className="base" style={{height:`${r.base/max*90}%`}}/><div className="fill" style={{height:`${r.adjusted/max*90}%`}}/><div className="actual" style={{height:`${r.actual/max*90}%`}}/></div><b>{r.sum}</b></div>)}</div>
        </div></div>
        <div className="chart-foot"><span>合計値</span><p>↗　確率は出目の偏りに応じて毎回更新されます</p></div>
      </div>
    </section>
  </main>
}
