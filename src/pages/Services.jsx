import { Helmet } from "react-helmet-async";
import { servicesData } from "../data/servicesData";
import SEO from "../components/SEO";

const nums = ["01", "02", "03", "04", "05", "06"];

const Services = () => {
  const servicesSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: servicesData.map((service, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "Service",
        name: service.title,
        description: service.shortDesc,
        provider: { "@type": "BeautySalon", name: "JT Studio" },
        areaServed: "Setúbal, Portugal",
        ...(service.price !== "Sob consulta" && {
          offers: {
            "@type": "Offer",
            price: service.price.replace("€", "").trim(),
            priceCurrency: "EUR",
          },
        }),
      },
    })),
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--cream)" }}>
      <SEO
        title="Serviços"
        description="Serviços de Micropigmentação, Nanoblading, Soft Eyeliner, Tattoo e Remoção a Laser em Setúbal. Preços a partir de 10€. Agende no JT Studio."
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(servicesSchema)}</script>
      </Helmet>

      {/* Page Header */}
      <section style={{ background: "var(--ink)", color: "var(--cream)", padding: "180px 0 100px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "radial-gradient(ellipse at 70% 30%,rgba(176,38,74,.18),transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(201,162,74,.1),transparent 50%)" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(45deg,rgba(232,217,192,.025) 0 1px,transparent 1px 4px)", mixBlendMode: "overlay", pointerEvents: "none" }} />
        <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px", position: "relative" }}
          className="max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "30px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
            Serviços
          </div>
          <h1 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(56px,7.5vw,120px)", lineHeight: 0.95, letterSpacing: "-0.03em", maxWidth: "1100px", margin: 0 }}>
            Seis técnicas.<br />Um{" "}
            <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>resultado natural.</em>
          </h1>
          <p style={{ fontSize: "19px", lineHeight: 1.55, color: "rgba(244,237,228,.78)", maxWidth: "640px", marginTop: "30px", fontWeight: 300 }}>
            Conheça os serviços de micropigmentação, nanoblading, soft eyeliner, tattoo e remoção a laser disponíveis no JT Studio em Setúbal. Resultados naturais com segurança.
          </p>
          <div style={{ display: "flex", gap: "40px", marginTop: "48px", paddingTop: "28px", borderTop: "1px solid rgba(232,217,192,.18)", flexWrap: "wrap" }}>
            {[["Especialidades", "06"], ["Por marcação", "SumUp Bookings"], ["Localização", "Setúbal"]].map(([label, value]) => (
              <div key={label} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)" }}>— {label}</span>
                <span className="font-serif" style={{ fontSize: "22px", fontWeight: 400, fontStyle: "italic", color: "var(--cream)" }}>{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Services List */}
      <section style={{ padding: "120px 0", background: "var(--cream)" }}
        className="max-[700px]:!pt-[60px] max-[700px]:!pb-[70px]">
        <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px" }}
          className="max-[700px]:!px-[22px]">
          <div className="svc-list">
            {servicesData.map((svc, i) => (
              <a
                key={svc.id}
                href={svc.bookingUrl}
                target="_blank" rel="noopener noreferrer"
                className="svc-row"
              >
                <span className="font-mono" style={{ fontSize: "14px", letterSpacing: "0.18em", color: "var(--rose)" }}>
                  {nums[i]}
                </span>
                <div style={{ width: "110px", height: "140px", overflow: "hidden", borderRadius: "6px", background: "var(--cream-2)", position: "relative", flexShrink: 0 }}>
                  <img src={svc.imageUrl} alt={svc.title} loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform .8s ease" }}
                    onMouseEnter={e => e.currentTarget.style.transform = "scale(1.08)"}
                    onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
                  />
                </div>
                <div>
                  <div className="font-serif" style={{ fontSize: "32px", fontWeight: 400, letterSpacing: "-0.015em", lineHeight: 1.1 }}>
                    <em style={{ fontStyle: "italic", color: "var(--rose)" }}>{svc.nameItalic}</em>{svc.nameRest}
                  </div>
                  <div style={{ fontSize: "14.5px", lineHeight: 1.55, color: "var(--muted)", marginTop: "8px" }}>
                    {svc.shortDesc}
                  </div>
                </div>
                <div className="svc-row-desc-long" style={{ fontSize: "14.5px", lineHeight: 1.55, color: "var(--muted)" }}>
                  {svc.description}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <span className="font-serif" style={{ fontSize: "30px", fontStyle: "italic", color: "var(--ink)", fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1 }}>
                    {svc.price}
                  </span>
                  <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--muted)" }}>
                    — {svc.duration}
                  </span>
                </div>
                <span className="svc-row-book-col font-sans font-semibold uppercase" style={{
                  textAlign: "center", padding: "16px 24px", borderRadius: "999px",
                  background: "var(--ink)", color: "var(--cream)",
                  fontSize: "12px", letterSpacing: "0.15em",
                  transition: "background .3s",
                }}>
                  Agendar
                </span>
              </a>
            ))}
          </div>

          {/* Image strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: "14px", marginTop: "90px" }}
            className="max-[900px]:![grid-template-columns:repeat(3,1fr)]">
            {servicesData.map((svc) => (
              <div key={svc.id} style={{ aspectRatio: "3/4", overflow: "hidden", background: "var(--cream-2)", position: "relative" }}>
                <img src={svc.imageUrl} alt={svc.stripLabel}
                  style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform .8s ease" }}
                  onMouseEnter={e => e.currentTarget.style.transform = "scale(1.06)"}
                  onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
                />
                <span className="font-mono" style={{
                  position: "absolute", bottom: "10px", left: "10px",
                  fontSize: "10px", letterSpacing: "0.22em", textTransform: "uppercase",
                  background: "rgba(20,17,16,.85)", color: "var(--cream)",
                  padding: "6px 10px", borderRadius: "999px",
                }}>
                  {svc.stripLabel}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export default Services;
