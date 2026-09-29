import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

// Requests enter through the core server (TaskFlow). The bus has a different
// job: it publishes streamed updates from core back to every connected client.
export function EventFlow() {
  return (
    <g className={styles.flowLineGroup}>
      <path
        d="M 390 350 C 330 405 265 420 210 420"
        stroke="rgba(34,211,238,0.75)"
        strokeWidth="2"
        strokeDasharray="5 5"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="210,420 219,415 219,425" fill="#22d3ee" />
      <path
        d="M 184 385 L 150 385"
        stroke="rgba(34,211,238,0.75)"
        strokeWidth="2"
        strokeDasharray="5 5"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="150,385 159,380 159,390" fill="#22d3ee" />
      <text x="270" y="410" className={styles.connectionLabel} fill="#67e8f9" textAnchor="middle">
        streamed events
      </text>
    </g>
  );
}
