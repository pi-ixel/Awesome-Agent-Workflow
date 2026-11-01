import { useState, type CSSProperties } from "react";
import logo from "../assets/aaw-logo.png";
import "./StartupGate.css";

const greetings = [
  "今天别忘记打卡哦~",
  "久坐了记得起来走走",
  "是时候喝点水了",
  "扶摇直上九万里，吾辈岂是蓬蒿人",
];

/** Shared brand animation; presentation only, never controls connection timing. */
export function BrandLoading({
  caption,
  hint,
  compact = false,
  immersive = false,
}: {
  readonly caption?: string;
  readonly hint?: string;
  readonly compact?: boolean;
  readonly immersive?: boolean;
}) {
  // Pick once per loading screen; replay updates must not shuffle the greeting.
  const [greeting] = useState(
    () => greetings[Math.floor(Math.random() * greetings.length)]!,
  );
  const Heading = compact || immersive ? "h2" : "h1";
  return (
    <div
      className={`startup-brand${immersive ? " startup-brand--immersive" : compact ? " startup-brand--compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="startup-mark" aria-hidden="true">
        <div className="startup-halo" />
        <img className="startup-logo" src={logo} alt="" draggable={false} />
      </div>
      <Heading className="startup-name">
        Awesome Agent <span>Workspace</span>
      </Heading>
      <p className="startup-hint startup-handwriting">
        <span className="sr-only">{hint ?? greeting}</span>
        <span aria-hidden="true">
          {Array.from(hint ?? greeting).map((character, index) => (
            <span
              className="startup-written-character"
              key={index}
              style={
                { "--write-delay": `${index * 70 + 150}ms` } as CSSProperties
              }
            >
              <span className="startup-ink">{character}</span>
              <svg className="startup-pen" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 20 7 10 17 3 21 7 14 17 4 20Z"
                  fill="currentColor"
                />
                <path
                  d="m4 20 8-8"
                  stroke="var(--color-base)"
                  strokeWidth="1.2"
                />
                <circle cx="12" cy="12" r="1.5" fill="var(--color-base)" />
              </svg>
            </span>
          ))}
        </span>
      </p>
      {caption ? <p className="startup-caption">{caption}</p> : null}
    </div>
  );
}
