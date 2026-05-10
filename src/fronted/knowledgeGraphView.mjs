import { graphVisualData } from "./graphLayout.mjs";

export function createKnowledgeGraphView({
  container,
  emptyState,
  cytoscape,
  onNodeSelect = () => {}
}) {
  let cy = null;

  function graphStyle() {
    return [
      {
        selector: "node",
        style: {
          width: "data(size)",
          height: "data(size)",
          shape: "data(nodeShape)",
          "background-color": "data(color)",
          "border-width": 3,
          "border-color": "data(sourceColor)",
          "border-opacity": 0.9,
          label: "data(label)",
          color: "#262018",
          "font-family": "serif",
          "font-size": "data(fontSize)",
          "font-weight": "bold",
          "text-wrap": "wrap",
          "text-max-width": "data(textMaxWidth)",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": "data(textMarginY)",
          "text-background-color": "#fffaf2",
          "text-background-opacity": 0.82,
          "text-background-padding": 3,
          "overlay-opacity": 0
        }
      },
      {
        selector: "node[isChapter]",
        style: {
          "text-valign": "bottom",
          "text-halign": "center",
          "text-background-opacity": 0.86,
          "text-background-color": "#fffaf2",
          color: "#262018",
          "font-size": 10,
          "font-weight": "bold",
          "border-width": 0
        }
      },
      {
        selector: "node:selected, node.focused",
        style: {
          "border-width": 5,
          "border-color": "#d85d34",
          "background-blacken": -0.08
        }
      },
      {
        selector: "node.highlight",
        style: {
        "border-width": 5,
        "border-color": "#d85d34",
        "background-blacken": -0.14
      }
    },
      {
        selector: "node.dimmed",
        style: {
          opacity: 0.22,
          "text-opacity": 0.12
        }
      },
      {
        selector: "edge",
        style: {
          width: 1.2,
          "line-color": "data(color)",
          "line-opacity": 0.36,
          "target-arrow-color": "data(color)",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.8,
          "curve-style": "bezier",
          "control-point-step-size": 42,
          label: "",
          color: "#554a3a",
          "font-size": 8,
          "text-background-color": "#fffaf2",
          "text-background-opacity": 0.92,
          "text-background-padding": 3,
          "text-rotation": "autorotate"
        }
      },
      {
        selector: "edge[derived]",
        style: {
          "line-style": "dashed",
          "line-opacity": 0.18,
          width: 0.9
        }
      },
      {
        selector: "edge.focused, edge:selected",
        style: {
          width: 2.8,
          "line-opacity": 0.92,
          label: "data(label)",
          "z-index": 8
        }
      },
      {
        selector: "edge.dimmed",
        style: {
          opacity: 0.08
        }
      }
    ];
  }

  function focusNeighborhood(node) {
    if (!cy) return;
    const neighborhood = node.closedNeighborhood();
    cy.elements().addClass("dimmed");
    neighborhood.removeClass("dimmed");
    node.addClass("focused");
    node.connectedEdges().addClass("focused");
  }

  function clearFocus() {
    if (!cy) return;
    cy.elements().removeClass("dimmed focused");
  }

  function bindEvents() {
    cy.on("tap", "node", (event) => onNodeSelect(event.target.data("raw")));
    cy.on("mouseover", "node", (event) => focusNeighborhood(event.target));
    cy.on("mouseout", "node", clearFocus);
    cy.on("mouseover", "edge", (event) => event.target.addClass("focused"));
    cy.on("mouseout", "edge", (event) => event.target.removeClass("focused"));
  }

  function render(graph) {
    const { elements } = graphVisualData(graph);
    const hasGraph = elements.some((element) => element.group === "nodes");
    emptyState?.classList.toggle("visible", !hasGraph);

    if (!cy) {
      cy = cytoscape({
        container,
        elements,
        wheelSensitivity: 0.22,
        minZoom: 0.12,
        maxZoom: 2.6,
        style: graphStyle(),
        layout: {
          name: "preset",
          animate: false,
          fit: true,
          padding: 86
        }
      });
      bindEvents();
      return;
    }

    cy.elements().remove();
    cy.add(elements);
    cy.style(graphStyle());
    cy.layout({ name: "preset", animate: false, fit: true, padding: 86 }).run();
  }

  function fit() {
    cy?.fit(undefined, 60);
  }

  function search(queryText) {
    if (!cy) return;
    const query = String(queryText ?? "").trim().toLocaleLowerCase("zh-CN");
    cy.nodes().removeClass("highlight");
    if (!query) return;
    const matches = cy.nodes().filter((node) => {
      const data = node.data();
      return [data.label, data.fullLabel, data.definition, data.category, data.chapter, data.textbook]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(query);
    });
    matches.addClass("highlight");
    if (matches.length > 0) cy.fit(matches, 80);
  }

  return {
    render,
    fit,
    search,
    get instance() {
      return cy;
    }
  };
}
