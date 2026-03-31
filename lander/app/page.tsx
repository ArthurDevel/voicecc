// Voice CC landing page.
// - Renders the main marketing/install page
// - Includes copy-to-clipboard functionality for code blocks
"use client";

import { useCallback } from "react";
import Link from "next/link";

// ============================================================================
// CONSTANTS
// ============================================================================

const COPY_RESET_DELAY_MS = 1500;

const INSTALL_STEPS = [
  {
    number: 1,
    title: "Install system dependencies",
    description:
      "Requires macOS with Apple Silicon, Node.js 18+, Python 3.10+, and Homebrew.",
    code: "xcode-select --install\nbrew install espeak-ng",
  },
  {
    number: 2,
    title: "Install Voice CC",
    description: null,
    code: "npm install -g voicecc",
  },
  {
    number: 3,
    title: "Start the dashboard",
    description: null,
    code: "voicecc",
  },
] as const;

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * A code block with a copy-to-clipboard button.
 * @param code - The code string to display and copy
 */
function CodeBlock({ code }: { code: string }) {
  const handleCopy = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const btn = e.currentTarget;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, COPY_RESET_DELAY_MS);
      });
    },
    [code]
  );

  return (
    <div className="codeBlock">
      <button className="copyBtn" onClick={handleCopy}>
        Copy
      </button>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * A single install step with number badge, title, optional description, and code block.
 * @param step - The step data to render
 */
function InstallStep({
  step,
}: {
  step: (typeof INSTALL_STEPS)[number];
}) {
  return (
    <div className="step">
      <span className="stepNumber">{step.number}</span>
      <div className="stepBody">
        <div className="stepTitle">{step.title}</div>
        {step.description && (
          <div className="stepDesc">{step.description}</div>
        )}
        <CodeBlock code={step.code} />
      </div>
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function HomePage() {
  return (
    <div className="container">
      <h1>Voice CC</h1>
      <p className="tagline">
        A Claude Code plugin that adds a <code>/voice</code> command for
        hands-free voice interaction with local speech-to-text, text-to-speech,
        and voice activity detection.
      </p>

      <div className="section">
        <Link href="/marketplace" className="marketplaceLink">
          Browse Community Agents &rarr;
        </Link>
      </div>

      <div className="section">
        <h2>Install</h2>
        <div className="panel">
          {INSTALL_STEPS.map((step) => (
            <InstallStep key={step.number} step={step} />
          ))}
        </div>
      </div>
    </div>
  );
}
