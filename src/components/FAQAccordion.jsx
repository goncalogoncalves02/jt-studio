import { useState } from "react";

const FAQAccordion = ({ data }) => {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div style={{ marginTop: "38px" }}>
      {data.map((item, i) => {
        const isOpen = openIndex === i;
        return (
          <div key={item.id} style={{ borderTop: "1px solid var(--line)", ...(i === data.length - 1 ? { borderBottom: "1px solid var(--line)" } : {}) }}>
            <button
              onClick={() => setOpenIndex(isOpen ? -1 : i)}
              aria-expanded={isOpen}
              style={{
                width: "100%", textAlign: "left",
                padding: "28px 0",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: "30px",
                background: "none", border: "none", cursor: "pointer",
                color: isOpen ? "var(--rose)" : "var(--ink)",
                transition: "color .25s",
              }}
            >
              <span className="font-serif" style={{ fontSize: "24px", fontWeight: 400, lineHeight: 1.25, letterSpacing: "-0.005em" }}>
                {item.question}
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "14px", color: isOpen ? "var(--cream)" : "var(--rose)",
                width: "36px", height: "36px", borderRadius: "50%",
                border: "1px solid var(--line)",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
                background: isOpen ? "var(--rose)" : "transparent",
                borderColor: isOpen ? "var(--rose)" : "var(--line)",
                transform: isOpen ? "rotate(45deg)" : "rotate(0)",
                transition: "all .3s ease",
              }}>
                +
              </span>
            </button>

            <div style={{
              maxHeight: isOpen ? "400px" : "0",
              overflow: "hidden",
              transition: "max-height .4s ease",
            }}>
              <div style={{ padding: "0 0 32px", fontSize: "16px", lineHeight: 1.7, color: "var(--ink-soft)", maxWidth: "560px" }}>
                {item.answer}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default FAQAccordion;
