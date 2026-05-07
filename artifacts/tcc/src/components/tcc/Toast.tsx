import { useEffect, useState } from "react";
import { C, F } from "./constants";

type Variant = "success" | "error" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: Variant;
  action?: ToastAction;
}

let counter = 0;
const listeners = new Set<(items: ToastItem[]) => void>();
let memory: ToastItem[] = [];

function emit() {
  for (const l of listeners) l(memory);
}

export function showToast(input: { title: string; description?: string; variant?: Variant; duration?: number; action?: ToastAction }): void {
  const id = ++counter;
  const item: ToastItem = {
    id,
    title: input.title,
    description: input.description,
    variant: input.variant ?? "success",
    action: input.action,
  };
  memory = [...memory, item];
  emit();
  // Toasts with an action stick around longer (5s default vs 3.5s) so the
  // user has time to react. Caller can still override via `duration`.
  const dur = input.duration ?? (input.action ? 5000 : 3500);
  setTimeout(() => {
    memory = memory.filter(t => t.id !== id);
    emit();
  }, dur);
}

function dismissToast(id: number) {
  memory = memory.filter(t => t.id !== id);
  emit();
}

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>(memory);
  useEffect(() => {
    listeners.add(setItems);
    return () => { listeners.delete(setItems); };
  }, []);

  if (items.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: 24,
      right: 24,
      zIndex: 100000,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      pointerEvents: "none",
      fontFamily: F,
    }}>
      {items.map(item => {
        const accent = item.variant === "error" ? C.red : item.variant === "info" ? C.blu : C.grn;
        const bg = item.variant === "error" ? C.redBg : item.variant === "info" ? C.bluBg : C.grnBg;
        const icon = item.variant === "error" ? "✕" : item.variant === "info" ? "ℹ" : "✓";
        return (
          <div key={item.id} style={{
            background: C.card,
            borderLeft: `4px solid ${accent}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: "12px 16px",
            minWidth: 280,
            maxWidth: 380,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            pointerEvents: "auto",
            animation: "tcc-toast-in 180ms ease-out",
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: "50%", background: bg,
              color: accent, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 800, flexShrink: 0,
            }}>{icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.tx, marginBottom: item.description ? 2 : 0 }}>
                {item.title}
              </div>
              {item.description && (
                <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.4 }}>{item.description}</div>
              )}
              {item.action && (
                <button
                  onClick={() => { item.action!.onClick(); dismissToast(item.id); }}
                  style={{
                    marginTop: 8, padding: "5px 12px", borderRadius: 6,
                    border: `1px solid ${accent}`, background: bg, color: accent,
                    fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: F,
                  }}
                >{item.action.label}</button>
              )}
            </div>
          </div>
        );
      })}
      <style>{`
        @keyframes tcc-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
