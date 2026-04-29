import { useEffect } from "react";

const Lightbox = ({ image, onClose }) => {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!image) return null;

  return (
    <div
      role="dialog" aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        background: "rgba(20,17,16,.95)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "40px",
      }}
    >
      <button
        onClick={onClose}
        aria-label="Fechar"
        style={{
          position: "absolute", top: "24px", right: "24px",
          width: "48px", height: "48px", borderRadius: "50%",
          background: "var(--cream)", color: "var(--ink)",
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "18px",
        }}
      >
        ✕
      </button>

      <img
        src={image.src}
        alt={image.alt}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain" }}
      />

      {image.cap && (
        <div
          className="font-mono"
          style={{
            position: "absolute", bottom: "28px", left: "50%", transform: "translateX(-50%)",
            fontSize: "12px", letterSpacing: "0.2em", textTransform: "uppercase",
            color: "var(--gold-light)",
            background: "rgba(20,17,16,.6)", padding: "10px 18px", borderRadius: "999px",
            border: "1px solid rgba(232,217,192,.2)",
            whiteSpace: "nowrap",
          }}
        >
          {image.cap}
        </div>
      )}
    </div>
  );
};

export default Lightbox;
