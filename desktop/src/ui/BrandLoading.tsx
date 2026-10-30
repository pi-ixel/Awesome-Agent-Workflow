import logo from "../assets/aaw-logo.png";
import "./StartupGate.css";

/** Shared brand animation; presentation only, never controls connection timing. */
export function BrandLoading({
  caption,
  hint,
  compact = false,
  immersive = false,
}: {
  readonly caption: string;
  readonly hint?: string;
  readonly compact?: boolean;
  readonly immersive?: boolean;
}) {
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
      <p className="startup-caption">{caption}</p>
      {hint ? <p className="startup-hint">{hint}</p> : null}
    </div>
  );
}
