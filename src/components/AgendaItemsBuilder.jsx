import { useId, useLayoutEffect, useRef, useState } from "react";
import { BusyFieldset } from "./BusyControls.jsx";
import "../lib/i18n/features/agendaItemsStrings.js";

// Small structured authoring helper over the already reviewed event agenda
// field. Keep legacy text editable and preserve the existing minutes linkage.
let itemSequence = 0;
function blankItem() {
  itemSequence += 1;
  return { id: `agenda-item-${itemSequence}`, topic: "", owner: "", minutes: 10, outcome: "" };
}
const wholeMinutes = (item) => /^\d{1,3}$/.test(String(item.minutes)) && Number(item.minutes) >= 1 && Number(item.minutes) <= 240;

// The topic and responsible person are required for Append only. They carry
// aria-required rather than native `required`: the builder sits inside the
// Save agenda form, which an empty placeholder item must not block.
export function AgendaItemsBuilder({ t, pending, agenda, onAppend, agendaFieldRef }) {
  const [items, setItems] = useState(() => [blankItem()]);
  const [status, setStatus] = useState("");
  const controls = useRef(new Map());
  const addRef = useRef(null);
  const focusAfter = useRef(null);
  const reasonId = useId();
  // Continue an ordered agenda instead of restarting at 1 on every Append.
  const start = 1 + (agenda.match(/^\d+\. /gm) || []).length;
  const textOf = (rows) => rows.map((item, index) => [
    `${start + index}. ${item.topic.trim()}`,
    `${t("agendaItems.owner")}: ${item.owner.trim()} · ${t("agendaItems.time")}: ${Number(item.minutes)}`,
    item.outcome.trim() && `${t("agendaItems.outcome")}: ${item.outcome.trim()}`,
  ].filter(Boolean).join("\n")).join("\n\n");
  const join = (rows) => [agenda.trim(), textOf(rows)].filter(Boolean).join("\n\n");
  const combined = join(items);
  // Only items the user has started count toward the length limit, so the
  // empty placeholder never raises the alert before anything is typed. Append
  // needs every item complete, so this also covers the full combined text.
  const tooLong = join(items.filter((item) => item.topic.trim())).length > 4000;
  const reason = tooLong ? "agendaItems.tooLong"
    : !items.every((item) => item.topic.trim() && item.owner.trim()) ? "agendaItems.needsFields"
    : !items.every(wholeMinutes) ? "agendaItems.needsMinutes" : "";

  useLayoutEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (!target) return;
    if (target === "agenda") {
      (agendaFieldRef?.current ?? controls.current.get(`${items[0].id}:topic`))?.focus();
      return;
    }
    if (target === "add") { addRef.current?.focus(); return; }
    const preferred = controls.current.get(`${target.id}:${target.key}`);
    const element = preferred && !preferred.disabled ? preferred : controls.current.get(`${target.id}:${target.fallback}`);
    element?.focus();
  }, [items, agendaFieldRef]);

  const bind = (id, key) => (element) => {
    if (element) controls.current.set(`${id}:${key}`, element);
    else controls.current.delete(`${id}:${key}`);
  };
  function update(index, key, value) { setItems((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value } : row)); }
  function move(index, step) {
    const next = [...items];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    const [key, fallback] = step < 0 ? ["up", "down"] : ["down", "up"];
    focusAfter.current = { id: items[index].id, key, fallback };
    setItems(next);
    setStatus(t("agendaItems.moved", { number: index + step + 1 }));
  }
  function remove(index) {
    focusAfter.current = index > 0 ? { id: items[index - 1].id, key: "topic" } : "add";
    setItems(items.filter((_, i) => i !== index));
    setStatus(t("agendaItems.removed", { number: index + 1 }));
  }
  function append() {
    onAppend(combined);
    focusAfter.current = "agenda";
    setItems([blankItem()]);
    setStatus(t("agendaItems.appended"));
  }
  return <details>
    <summary style={{minHeight:48}}>{t("agendaItems.title")}</summary>
    <p>{t("agendaItems.help")}</p>
    <BusyFieldset pending={pending}>
      <legend>{t("agendaItems.title")}</legend>
      {items.map((item,index) => <fieldset key={item.id}>
        <legend>{t("agendaItems.item",{number:index+1})}</legend>
        {[['topic',160,true],['owner',120,true],['outcome',300,false]].map(([key,maxLength,required]) => <label className="xus-field" key={key}>
          <span>{required ? t(`agendaItems.${key}`) : `${t(`agendaItems.${key}`)} (${t("agendaItems.optional")})`}{required && <span aria-hidden="true"> ({t("agendaItems.required")})</span>}</span>
          <input ref={bind(item.id,key)} className="xus-input" style={{minHeight:48}} maxLength={maxLength} aria-required={required || undefined} value={item[key]} onChange={(event) => update(index,key,event.target.value)} />
        </label>)}
        <label className="xus-field">{t("agendaItems.time")}<input className="xus-input" style={{minHeight:48}} type="number" min={1} max={240} step={1} value={item.minutes} onChange={(event)=>update(index,"minutes",event.target.value)} /></label>
        <div className="xus-btnrow">
          <button ref={bind(item.id,"up")} type="button" className="xus-btn" style={{minHeight:48}} disabled={index===0} onClick={()=>move(index,-1)}>{t("agendaItems.up",{number:index+1})}</button>
          <button ref={bind(item.id,"down")} type="button" className="xus-btn" style={{minHeight:48}} disabled={index===items.length-1} onClick={()=>move(index,1)}>{t("agendaItems.down",{number:index+1})}</button>
          <button type="button" className="xus-btn" style={{minHeight:48}} disabled={items.length===1} onClick={()=>remove(index)}>{t("agendaItems.remove",{number:index+1})}</button>
        </div>
      </fieldset>)}
      <button ref={addRef} type="button" className="xus-btn" style={{minHeight:48}} disabled={items.length>=20} onClick={()=>setItems((rows)=>[...rows,blankItem()])}>{t("agendaItems.add")}</button>
      {reason && <p id={reasonId} className="xus-eline" role={reason==="agendaItems.tooLong" ? "alert" : undefined}>{t(reason)}</p>}
      <button type="button" className="xus-btn" style={{minHeight:48}} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined} onClick={append}>{t("agendaItems.append")}</button>
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
    </BusyFieldset>
  </details>;
}
