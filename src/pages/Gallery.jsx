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
    <div className="min-h-screen bg-ink text-cream">
      <SEO
        title="Galeria"
        description="Galeria de resultados de Nanoblading, Micropigmentação Labial e Tattoo no JT Studio em Setúbal. Fotos reais de antes e depois."
      />

      {/* Page Header */}
      <section className="page-header-section bg-ink relative overflow-hidden">
        <div className="grain-overlay" />
        <div className="max-w-[1440px] mx-auto px-12 relative max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center gap-[14px] mb-[30px] text-[12px] tracking-[0.25em] uppercase text-gold-light">
            <span className="w-[30px] h-px bg-gold-light block shrink-0" />
            Galeria · Portfólio
          </div>
          <h1 className="font-serif font-light text-[clamp(56px,7.5vw,120px)] leading-[0.95] tracking-[-0.03em] m-0">
            O trabalho,<br />em <em className="italic text-gold-light">close-up.</em>
          </h1>
          <p className="text-[19px] max-[700px]:text-[16px] leading-[1.55] text-cream/[.78] max-w-[640px] mt-[30px] font-light">
            Resultados reais de nanoblading, micropigmentação labial e tattoo realizados no JT Studio em Setúbal.
          </p>
        </div>
      </section>

      {/* Gallery Section */}
      <section className="pt-[90px] pb-[120px] bg-ink max-[900px]:!pt-[60px] max-[900px]:!pb-[80px]">
        <div className="max-w-[1640px] mx-auto px-12 max-[700px]:!px-[22px]">

          {/* Filters */}
          <div className="gallery-filter-bar flex gap-[10px] flex-wrap mb-[50px] pb-[40px] border-b border-cream/[.12] items-center justify-between">
            <div className="flex gap-[10px] flex-wrap">
              {galFilters.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setActiveFilter(f.key)}
                  className={`font-mono text-[11px] tracking-[0.2em] uppercase py-[11px] px-5 rounded-full border cursor-pointer transition-all duration-[250ms] ${activeFilter === f.key ? "bg-rose border-rose text-cream" : "bg-transparent border-cream/25 text-cream hover:border-cream/60"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-cream/60">
              — {String(visible.length).padStart(2, "0")} trabalhos
            </span>
          </div>

          {/* Masonry grid */}
          <div className="gallery-grid">
            {galleryImages.map((img, i) => (
              <div
                key={img.id}
                className={`g-tile group ${galWidths[i]} ${visible.includes(img) ? "" : "hidden"}`}
                onClick={() => setLightboxImage(img)}
              >
                <img src={img.src} alt={img.alt} loading="lazy" />
                <span className="font-mono absolute left-[18px] bottom-[18px] right-[18px] text-[10px] tracking-[0.22em] uppercase text-cream z-[2] opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-[350ms] ease-in-out">
                  — {img.cap}
                </span>
                <span className="absolute top-[14px] right-[14px] w-[34px] h-[34px] rounded-full bg-cream/[.92] text-ink flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 text-[14px] z-[2] pointer-events-none">
                  ⤢
                </span>
              </div>
            ))}
          </div>

          {/* Instagram CTA */}
          <div className="mt-[80px] pt-[60px] border-t border-cream/[.15] flex justify-between items-center flex-wrap gap-[30px] max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-[18px] max-[700px]:mt-[50px] max-[700px]:pt-[36px]">
            <h3 className="font-serif font-light text-[clamp(30px,4vw,48px)] tracking-[-0.02em] m-0">
              Mais trabalhos no{" "}
              <em className="italic text-gold-light">Instagram.</em>
            </h3>
            <a
              href="https://www.instagram.com/jtmicroblading/"
              target="_blank" rel="noopener noreferrer"
              className="font-sans font-semibold uppercase inline-flex items-center gap-3 bg-rose text-cream py-[18px] px-8 rounded-full text-[13px] tracking-[0.12em] no-underline hover:bg-cream hover:text-ink transition-all duration-300"
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
