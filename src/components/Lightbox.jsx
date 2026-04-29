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
      className="fixed inset-0 z-[200] bg-ink/95 flex items-center justify-center p-10"
    >
      <button
        onClick={onClose}
        aria-label="Fechar"
        className="absolute top-6 right-6 w-12 h-12 rounded-full bg-cream text-ink border-0 cursor-pointer flex items-center justify-center text-[18px] hover:bg-gold-light transition-colors duration-200"
      >
        ✕
      </button>

      <img
        src={image.src}
        alt={image.alt}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[88vh] object-contain"
      />

      {image.cap && (
        <div className="absolute bottom-7 left-1/2 -translate-x-1/2 font-mono text-[12px] tracking-[0.2em] uppercase text-gold-light bg-ink/60 py-[10px] px-[18px] rounded-full border border-cream/20 whitespace-nowrap">
          {image.cap}
        </div>
      )}
    </div>
  );
};

export default Lightbox;
