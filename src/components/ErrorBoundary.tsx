import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

// Why this exists.
//
// There was no error boundary anywhere in this app, which means ANY exception
// thrown during render unmounts the whole tree and you get a white screen with
// no explanation. That is how "the Vol Desk tab opens then goes blank" happens:
// one row in one table touches a field that isn't there, React tears the page
// down, and the failure looks like a scrolling or layout bug rather than a
// TypeError with a stack trace sitting in the console.
//
// The specific crash was `p.expiry.slice(5)` on a SHARES position, which has no
// expiry — and share positions only started appearing because the share fallback
// was fixed to actually fire. So a backend fix surfaced as a frontend blank page.
// That will happen again the next time a payload shape changes, which is exactly
// why the boundary matters more than the individual guard: it turns a silent
// white screen into a legible error next to a Retry button, and keeps the rest of
// the app usable.
interface Props { children: ReactNode; name?: string }
interface State { error: Error | null; info: string }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack somewhere reachable — the console message is the thing that
    // actually tells you which field was missing.
    console.error(`[${this.props.name || "view"}] render failed`, error, info.componentStack);
    this.setState({ info: String(info.componentStack || "").split("\n").slice(0, 6).join("\n") });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel" style={{ borderColor: "var(--red)" }}>
        <strong style={{ color: "var(--red)" }}>
          This view hit an error and stopped rendering
        </strong>
        <p className="hint" style={{ marginTop: 6 }}>
          The rest of the app still works — switch tabs, or retry below. If this
          followed a data change, the message names the field that went missing.
        </p>
        <pre style={{
          background: "rgba(239,83,80,.08)", padding: 10, borderRadius: 6,
          overflow: "auto", fontSize: 12, marginTop: 8, whiteSpace: "pre-wrap",
        }}>
          {error.name}: {error.message}
          {info ? `\n${info}` : ""}
        </pre>
        <button className="primary" onClick={() => this.setState({ error: null, info: "" })}>
          Retry render
        </button>
      </div>
    );
  }
}
