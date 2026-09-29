import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";

export function TaskFlow() {
  return (
    <g className={styles.flowLineGroup}>
      <path
        id="flow-task"
        d="M 150 300 L 220 300 M 365 300 L 392 300"
        stroke="rgba(249,115,22,0.85)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="8 6"
        className={styles.flowLine}
        fill="none"
      />
      <polygon points="392,300 382,295 382,305" fill="rgba(249,115,22,0.85)" />
      <rect
        x="151"
        y="278"
        width="68"
        height="18"
        rx="4"
        fill="#0b0b14"
        stroke="rgba(249,115,22,0.26)"
        strokeWidth="1"
      />
      <text
        x="185"
        y="291"
        className={styles.connectionLabel}
        fill="rgba(255,255,255,0.76)"
        textAnchor="middle"
      >
        request
      </text>
    </g>
  );
}
