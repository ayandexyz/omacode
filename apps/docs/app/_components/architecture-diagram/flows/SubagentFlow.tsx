import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

export function SubagentFlow() {
  return (
    <g className={styles.flowLineGroup}>
      <path
        id="flow-subagent-out"
        d="M 440 220 Q 390 180 360 150"
        stroke="url(#grad-subagent)"
        strokeWidth="2"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
      />
      <polygon points="360,150 368,155 360,161" fill="#ec4899" />
      <text
        x="340"
        y="210"
        className={styles.connectionLabel}
        fill="#ec4899"
        textAnchor="end"
      >
        delegate subtasks
      </text>

      <path
        id="flow-subagent-in"
        d="M 360 170 Q 380 205 440 240"
        stroke="url(#grad-subagent)"
        strokeWidth="2"
        strokeDasharray="6 4"
        className={styles.flowLineSlow}
      />
      <polygon points="440,240 435,231 443,233" fill="#f97316" />
      <text
        x="395"
        y="200"
        className={styles.connectionLabel}
        fill="#f97316"
        textAnchor="start"
      >
        results
      </text>
    </g>
  );
}
