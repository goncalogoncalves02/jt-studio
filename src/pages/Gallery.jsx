import { useState } from "react";
import { galleryImages, galFilters, galWidths } from "../data/galleryData";
import Lightbox from "../components/Lightbox";
import SEO from "../components/SEO";

const Gallery = () => {
  const [activeFilter, setActiveFilter] = useState("all");
  const [lightboxImage, setLightboxImage] = useState(null);

  const visible = activeFilter === "all"
    ? galleryImages
    : galleryImages.filter((img) => img.cat === activeFilter);

  return (
    <div className="min-h-screen" style={{ background: "var(--ink)", color: "var(--cream)" }}>
      <SEO
        title="Galeria"
        description="Galeria de resultados de Nanoblading, Micropigmentação Labial e Tattoo no JT Studio em Setúbal. Fotos reais de antes e depois."
      />

      {/* Page Header */}
      <section style={{ background: "var(--ink)", padding: "180px 0 100px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(45deg,rgba(232,217,192,.025) 0 1px,transparent 1px 4px)", mixBlendMode: "overlay", pointerEvents: "none" }} />
        <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px", position: "relative" }}
          className="max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "30px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
            Galeria · Portfólio
          </div>
          <h1 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(56px,7.5vw,120px)", lineHeight: 0.95, letterSpacing: "-0.03em", margin: 0 }}>
            O trabalho,<br />em <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>close-up.</em>
          </h1>
          <p style={{ fontSize: "19px", lineHeight: 1.55, color: "rgba(244,237,228,.78)", maxWidth: "640px", marginTop: "30px", fontWeight: 300 }}>
            Resultados reais de nanoblading, micropigmentação labial e tattoo realizados no JT Studio em Setúbal.
          </p>
        </div>
      </section>

      {/* Gallery Section */}
      <section style={{ padding: "90px 0 120px", background: "var(--ink)" }}
        className="max-[900px]:!pt-[60px] max-[900px]:!pb-[80px]">
        <div style={{ maxWidth: "1640px", margin: "0 auto", padding: "0 48px" }}
          className="max-[700px]:!px-[22px]">

          {/* Filters */}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "50px", paddingBottom: "40px", borderBottom: "1px solid rgba(232,217,192,.12)", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {galFilters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setActiveFilter(f.key)}
                  className="font-mono"
                  style={{
                    fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase",
                    padding: "11px 20px", borderRadius: "999px",
                    border: `1px solid ${activeFilter === f.key ? "var(--rose)" : "rgba(232,217,192,.25)"}`,
                    background: activeFilter === f.key ? "var(--rose)" : "transparent",
                    color: "var(--cream)",
                    cursor: "pointer", transition: "all .25s ease",
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(244,237,228,.6)" }}>
              — {String(visible.length).padStart(2, "0")} trabalhos
            </span>
          </div>

          {/* Masonry grid */}
          <div className="gallery-grid">
            {galleryImages.map((img, i) => (
              <div
                key={img.id}
                className={`g-tile ${galWidths[i]}`}
                style={{ display: visible.includes(img) ? undefined : "none" }}
                onClick={() => setLightboxImage(img)}
              >
                <img src={img.src} alt={img.alt} loading="lazy" />
                <span className="font-mono" style={{
                  position: "absolute", left: "18px", bottom: "18px", right: "18px",
                  fontSize: "10px", letterSpacing: "0.22em", textTransform: "uppercase",
                  color: "var(--cream)", zIndex: 2,
                  opacity: 0, transform: "translateY(8px)", transition: "all .35s ease",
                }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "translateY(0)"; }}
                >
                  — {img.cap}
                </span>
                <span style={{
                  position: "absolute", top: "14px", right: "14px",
                  width: "34px", height: "34px", borderRadius: "50%",
                  background: "rgba(244,237,228,.92)", color: "var(--ink)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  opacity: 0, transition: "opacity .3s", fontSize: "14px", zIndex: 2,
                  cursor: "pointer",
                  pointerEvents: "none",
                }}>
                  ⤢
                </span>
              </div>
            ))}
          </div>

          {/* Instagram CTA */}
          <div style={{ marginTop: "80px", paddingTop: "60px", borderTop: "1px solid rgba(232,217,192,.15)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "30px" }}
            className="max-[700px]:!flex-col max-[700px]:!items-start max-[700px]:!gap-[18px] max-[700px]:!mt-[50px] max-[700px]:!pt-[36px]">
            <h3 className="font-serif" style={{ fontSize: "clamp(30px,4vw,48px)", fontWeight: 300, letterSpacing: "-0.02em", margin: 0 }}>
              Mais trabalhos no{" "}
              <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>Instagram.</em>
            </h3>
            <a
              href="https://www.instagram.com/jtmicroblading/"
              target="_blank" rel="noopener noreferrer"
              className="font-sans font-semibold uppercase inline-flex items-center gap-3"
              style={{
                background: "var(--rose)", color: "var(--cream)",
                padding: "18px 32px", borderRadius: "999px",
                fontSize: "13px", letterSpacing: "0.12em",
                textDecoration: "none", transition: "background .3s",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--cream)"}
              onMouseLeave={e => e.currentTarget.style.background = "var(--rose)"}
            >
              @jtmicroblading →
            </a>
          </div>
        </div>
      </section>

      {lightboxImage && (
        <Lightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
      )}
    </div>
  );
};

export default Gallery;
