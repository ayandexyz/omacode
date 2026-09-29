import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

export function SessionFlow() {
  return (
    <g className={styles.flowLineGroup}>
      <path
        d="M 470 220 L 470 160"
        stroke="rgba(148,163,184,0.8)"
        strokeWidth="2"
        strokeDasharray="5 5"
        className={styles.flowLineSlow}
        fill="none"
      />
      <polygon points="470,160 465,169 475,169" fill="#cbd5e1" />
      <text x="482" y="199" className={styles.connectionLabel} fill="#cbd5e1">
        history
      </text>
    </g>
  );
}
