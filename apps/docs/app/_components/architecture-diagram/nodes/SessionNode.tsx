import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";
import type { NodeType } from "../FreeCodeInternalDiagram";

interface SessionNodeProps {
  selectedNode: NodeType | null;
  onSelectNode: (node: NodeType) => void;
}

export function SessionNode({ selectedNode, onSelectNode }: SessionNodeProps) {
  const isActive = selectedNode === "sessions";

  return (
    <g
      className={`${styles.nodeGroup} ${isActive ? styles.activeNode : ""}`}
      onClick={() => onSelectNode("sessions")}
    >
      <rect
        x="395"
        y="60"
        width="150"
        height="100"
        rx="12"
        className={styles.nodeBoxSession}
        filter="url(#glow-white)"
      />
      <text x="470" y="86" className={styles.sessionHeader} textAnchor="middle">
        SESSIONS
      </text>
      <line x1="411" y1="96" x2="529" y2="96" stroke="rgba(148,163,184,0.35)" />
      <text x="470" y="120" className={styles.sessionText} textAnchor="middle">
        active conversation
      </text>
      <text x="470" y="141" className={styles.sessionText} textAnchor="middle">
        rollout log + trace
      </text>
      <text x="470" y="156" className={styles.sessionSubtext} textAnchor="middle">
        current work, not memory
      </text>
    </g>
  );
}
