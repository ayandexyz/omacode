import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";
import type { NodeType } from "../FreeCodeInternalDiagram";

interface ProviderNodeProps {
  selectedNode: NodeType | null;
  onSelectNode: (node: NodeType) => void;
}

export function ProviderNode({
  selectedNode,
  onSelectNode,
}: ProviderNodeProps) {
  const isActive = selectedNode === "provider";

  return (
    <g
      className={`${styles.nodeGroup} ${isActive ? styles.activeNode : ""}`}
      onClick={() => onSelectNode("provider")}
    >
      <rect
        x="460"
        y="430"
        width="150"
        height="150"
        rx="14"
        className={styles.nodeBoxProvider}
        filter="url(#glow-blue)"
      />
      <text
        x="535"
        y="456"
        className={styles.providerHeader}
        textAnchor="middle"
      >
        AI PROVIDERS
      </text>
      <line
        x1="476"
        y1="468"
        x2="594"
        y2="468"
        stroke="rgba(96,165,250,0.35)"
      />

      <rect
        x="480"
        y="482"
        width="110"
        height="30"
        rx="7"
        fill="rgba(56,189,248,0.12)"
        stroke="rgba(56,189,248,0.45)"
      />
      <text
        x="535"
        y="501"
        className={styles.providerCardText}
        textAnchor="middle"
      >
        API models (~198)
      </text>

      <rect
        x="480"
        y="520"
        width="110"
        height="26"
        rx="7"
        fill="rgba(96,165,250,0.1)"
        stroke="rgba(96,165,250,0.38)"
      />
      <text
        x="535"
        y="537"
        className={styles.providerCardText}
        textAnchor="middle"
      >
        Vercel AI SDK
      </text>

      <text
        x="535"
        y="556"
        className={styles.providerSubtext}
        textAnchor="middle"
      >
        Gemini web: direct protocol
      </text>
    </g>
  );
}
