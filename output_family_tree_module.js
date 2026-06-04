
      import React from "https://esm.sh/react@18.3.1?dev";
      import { createRoot } from "https://esm.sh/react-dom@18.3.1/client?dev";
      import {
        Background,
        Controls,
        Handle,
        MiniMap,
        Position,
        ReactFlow,
      } from "https://esm.sh/@xyflow/react@12.10.2?dev&bundle&deps=react@18.3.1,react-dom@18.3.1";

      const memberId =
        window.location.pathname
          .split("/")
          .pop();

      const titleElement =
        document.querySelector(
          "#family-tree-title"
        );
      const countElement =
        document.querySelector(
          "#family-tree-count"
        );
      const flowElement =
        document.querySelector(
          "#family-tree-flow"
        );

      function escapeHtml(value = "") {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function renderError(message) {
        flowElement.innerHTML = `
          <div class="tree-error">
            ${escapeHtml(message)}
          </div>
        `;
      }

      window.addEventListener(
        "error",
        (event) => {
          renderError(
            event.error?.message
            || event.message
            || "Tree rendering failed."
          );
        }
      );

      window.addEventListener(
        "unhandledrejection",
        (event) => {
          const reason =
            event.reason?.message
            || String(event.reason || "");

          if (reason) {
            renderError(reason);
          }
        }
      );

      function createStyledNodes(nodes = []) {
        return nodes.map((node) => {
          const isApplicant =
            node.data?.isApplicant;
          const isSpouseOnly =
            node.data?.isSpouseOnly;

          return {
            ...node,
            type: "familyMember",
            style: {
              background: "transparent",
              border: "none",
              boxShadow: "none",
              padding: 0,
            },
            data: {
              ...node.data,
              label: node.data?.fullName || "Unnamed member",
            },
          };
        });
      }

      function createStyledEdges(edges = []) {
        return edges.map((edge) => {
          const relationType =
            edge.data?.relationType;
          const isSpouse =
            relationType === "spouse_of";
          const sourceNode =
            edge.__sourceNode;
          const targetNode =
            edge.__targetNode;
          const sourceX =
            sourceNode?.position?.x || 0;
          const targetX =
            targetNode?.position?.x || 0;
          const sourceIsLeft =
            sourceX <= targetX;

          return {
            ...edge,
            type: "straight",
            sourceHandle: isSpouse
              ? sourceIsLeft
                ? "spouse-right-out"
                : "spouse-left-out"
              : "child-source",
            targetHandle: isSpouse
              ? sourceIsLeft
                ? "spouse-left-in"
                : "spouse-right-in"
              : "child-target",
            style: {
              stroke: isSpouse ? "#f59e0b" : "#94a3b8",
              strokeWidth: isSpouse ? 2.5 : 2,
              strokeDasharray: isSpouse ? "7 6" : "0",
            },
            animated: false,
          };
        });
      }

      function FamilyMemberNode({
        data,
      }) {
        const isApplicant =
          data?.isApplicant;
        const isSpouseOnly =
          data?.isSpouseOnly;

        const nodeStyle = {
          minWidth: isApplicant ? 190 : 150,
          maxWidth: isApplicant ? 240 : 190,
          borderRadius: 22,
          padding: isApplicant
            ? "14px 18px"
            : "12px 16px",
          fontSize: isApplicant ? 15 : 13,
          fontWeight: 700,
          color: "#0f172a",
          textAlign: "center",
          border: isApplicant
            ? "2px solid #0f766e"
            : isSpouseOnly
              ? "2px solid #f59e0b"
              : "1px solid rgba(15, 23, 42, 0.1)",
          boxShadow: isApplicant
            ? "0 14px 28px rgba(13, 148, 136, 0.18)"
            : "0 10px 20px rgba(15, 23, 42, 0.06)",
          background: isApplicant
            ? "linear-gradient(135deg, #ccfbf1, #ecfeff)"
            : isSpouseOnly
              ? "linear-gradient(135deg, #fef3c7, #fff7ed)"
              : "linear-gradient(135deg, #ffffff, #f8fafc)",
          position: "relative",
          whiteSpace: "normal",
          lineHeight: 1.25,
        };

        const handleBaseStyle = {
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "#1e293b",
          border: "2px solid #fff",
        };

        return React.createElement(
          "div",
          {
            style: nodeStyle,
          },
          React.createElement(Handle, {
            type: "target",
            position: Position.Top,
            id: "child-target",
            style: handleBaseStyle,
          }),
          React.createElement(Handle, {
            type: "source",
            position: Position.Bottom,
            id: "child-source",
            style: handleBaseStyle,
          }),
          React.createElement(Handle, {
            type: "source",
            position: Position.Right,
            id: "spouse-right-out",
            style: handleBaseStyle,
          }),
          React.createElement(Handle, {
            type: "target",
            position: Position.Right,
            id: "spouse-right-in",
            style: {
              ...handleBaseStyle,
              opacity: 0,
            },
          }),
          React.createElement(Handle, {
            type: "source",
            position: Position.Left,
            id: "spouse-left-out",
            style: handleBaseStyle,
          }),
          React.createElement(Handle, {
            type: "target",
            position: Position.Left,
            id: "spouse-left-in",
            style: {
              ...handleBaseStyle,
              opacity: 0,
            },
          }),
          React.createElement(
            "div",
            null,
            data?.label || "Unnamed member"
          )
        );
      }

      function FlowApp({
        nodes,
        edges,
      }) {
        const styledNodes =
          createStyledNodes(nodes);
        const nodesById =
          Object.fromEntries(
            styledNodes.map((node) => [
              node.id,
              node,
            ])
          );
        const styledEdges =
          createStyledEdges(
            edges.map((edge) => ({
              ...edge,
              __sourceNode: nodesById[edge.source],
              __targetNode: nodesById[edge.target],
            }))
          );

        return React.createElement(
          ReactFlow,
          {
            nodes: styledNodes,
            edges: styledEdges,
            fitView: true,
            minZoom: 0.2,
            maxZoom: 1.4,
            nodesDraggable: false,
            nodesConnectable: false,
            elementsSelectable: true,
            nodeTypes: {
              familyMember: FamilyMemberNode,
            },
            proOptions: {
              hideAttribution: true,
            },
            defaultViewport: {
              x: 0,
              y: 0,
              zoom: 0.9,
            },
          },
          React.createElement(Background, {
            gap: 22,
            size: 1.2,
            color: "#dbeafe",
          }),
          React.createElement(MiniMap, {
            pannable: true,
            zoomable: true,
            nodeColor: (node) =>
              node.data?.isApplicant
                ? "#14b8a6"
                : node.data?.isSpouseOnly
                  ? "#f59e0b"
                  : "#38bdf8",
            maskColor: "rgba(255,255,255,0.78)",
          }),
          React.createElement(Controls)
        );
      }

      async function loadTree() {
        try {
          const response =
            await fetch(
              `/api/family-tree/${memberId}`
            );

          if (!response.ok) {
            throw new Error(
              "Unable to load family tree."
            );
          }

          const payload =
            await response.json();
          const graph =
            payload.graph || {};
          const nodes =
            graph.nodes || [];
          const edges =
            graph.edges || [];

          titleElement.textContent =
            payload.member?.fullName
            || "Unnamed applicant";
          countElement.textContent =
            `${payload.member?.familyCount || nodes.length} visible family members`;

          flowElement.innerHTML = "";
          const root =
            createRoot(flowElement);

          root.render(
            React.createElement(
              FlowApp,
              {
                nodes,
                edges,
              }
            )
          );
        } catch (error) {
          renderError(
            error.message ||
            "Unable to load family tree."
          );
        }
      }

      loadTree();
    