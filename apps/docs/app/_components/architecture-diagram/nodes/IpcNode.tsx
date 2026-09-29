import React from "react";
import styles from "../FreeCodeInternalDiagram.module.css";
import type { NodeType } from "../FreeCodeInternalDiagram";

interface IpcNodeProps {
  selectedNode: NodeType | null;
  onSelectNode: (node: NodeType) => void;
}

export function IpcNode({ selectedNode, onSelectNode }: IpcNodeProps) {
  const isActive = selectedNode === "ipc";

  return (
    <g
      className={`${styles.nodeGroup} ${isActive ? styles.activeNode : ""}`}
      onClick={() => onSelectNode("ipc")}
    >
      <rect
        x="220"
        y="255"
        width="145"
        height="110"
        rx="12"
        className={styles.nodeBoxIpc}
        filter="url(#glow-cyan)"
      />
      <text x="292.5" y="282" className={styles.ipcHeader} textAnchor="middle">
        CORE SERVER
      </text>
      <line x1="235" y1="292" x2="350" y2="292" stroke="rgba(34,211,238,0.3)" />
      <text x="292.5" y="315" className={styles.ipcText} textAnchor="middle">
        JSON-RPC requests
      </text>
      <text x="292.5" y="334" className={styles.ipcText} textAnchor="middle">
        stdio · HTTP
      </text>
      <text x="292.5" y="351" className={styles.ipcSubtext} textAnchor="middle">
        session handler
      </text>
    </g>
  );
}
