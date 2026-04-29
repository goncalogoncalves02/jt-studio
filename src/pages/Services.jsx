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
    <div className="min-h-screen bg-cream">
      <SEO
        title="Serviços"
        description="Serviços de Micropigmentação, Nanoblading, Soft Eyeliner, Tattoo e Remoção a Laser em Setúbal. Preços a partir de 10€. Agende no JT Studio."
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(servicesSchema)}</script>
      </Helmet>

      {/* Page Header */}
      <section className="page-header-section bg-ink text-cream relative overflow-hidden">
        <div className="ink-gradient-overlay" />
        <div className="grain-overlay" />
        <div className="max-w-[1440px] mx-auto px-12 relative max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center gap-[14px] mb-[30px] text-[12px] tracking-[0.25em] uppercase text-gold-light">
            <span className="w-[30px] h-px bg-gold-light block shrink-0" />
            Serviços
          </div>
          <h1 className="font-serif font-light text-[clamp(56px,7.5vw,120px)] leading-[0.95] tracking-[-0.03em] max-w-[1100px] m-0">
            Seis técnicas.<br />Um{" "}
            <em className="italic text-gold-light">resultado natural.</em>
          </h1>
          <p className="text-[19px] max-[700px]:text-[16px] leading-[1.55] text-cream/[.78] max-w-[640px] mt-[30px] font-light">
            Conheça os serviços de micropigmentação, nanoblading, soft eyeliner, tattoo e remoção a laser disponíveis no JT Studio em Setúbal. Resultados naturais com segurança.
          </p>
          <div className="flex gap-[40px] max-[700px]:gap-6 mt-12 pt-7 border-t border-cream/[.18] flex-wrap">
            {[["Especialidades", "06"], ["Por marcação", "SumUp Bookings"], ["Localização", "Setúbal"]].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light">— {label}</span>
                <span className="font-serif text-[22px] font-normal italic text-cream">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Services List */}
      <section className="py-[120px] bg-cream max-[700px]:!pt-[60px] max-[700px]:!pb-[70px]">
        <div className="max-w-[1440px] mx-auto px-12 max-[700px]:!px-[22px]">
          <div className="svc-list">
            {servicesData.map((svc, i) => (
              <a
                key={svc.id}
                href={svc.bookingUrl}
                target="_blank" rel="noopener noreferrer"
                className="svc-row"
              >
                <span className="font-mono text-[14px] tracking-[0.18em] text-rose">
                  {nums[i]}
                </span>
                <div className="w-[110px] h-[140px] overflow-hidden rounded-[6px] bg-cream-2 relative shrink-0">
                  <img
                    src={svc.imageUrl} alt={svc.title} loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-[800ms] ease-in-out hover:scale-[1.08]"
                  />
                </div>
                <div>
                  <div className="font-serif text-[32px] font-normal tracking-[-0.015em] leading-[1.1]">
                    <em className="italic text-rose">{svc.nameItalic}</em>{svc.nameRest}
                  </div>
                  <div className="text-[14.5px] leading-[1.55] text-muted mt-2">
                    {svc.shortDesc}
                  </div>
                </div>
                <div className="svc-row-desc-long text-[14.5px] leading-[1.55] text-muted">
                  {svc.description}
                </div>
                <div className="flex flex-col gap-2">
                  <span className="font-serif text-[30px] italic text-ink font-light tracking-[-0.02em] leading-none">
                    {svc.price}
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted">
                    — {svc.duration}
                  </span>
                </div>
                <span className="svc-row-book-col font-sans font-semibold uppercase text-center py-4 px-6 rounded-full bg-ink text-cream text-[12px] tracking-[0.15em] transition-colors duration-300 hover:bg-rose">
                  Agendar
                </span>
              </a>
            ))}
          </div>

          {/* Image strip */}
          <div className="svc-image-strip grid grid-cols-6 gap-[14px] mt-[90px] max-[900px]:grid-cols-3 max-[700px]:mt-[50px] max-[700px]:gap-2">
            {servicesData.map((svc) => (
              <div key={svc.id} className="aspect-[3/4] overflow-hidden bg-cream-2 relative">
                <img
                  src={svc.imageUrl} alt={svc.stripLabel}
                  className="w-full h-full object-cover transition-transform duration-[800ms] ease-in-out hover:scale-[1.06]"
                />
                <span className="font-mono absolute bottom-[10px] left-[10px] text-[10px] tracking-[0.22em] uppercase bg-ink/85 text-cream py-[6px] px-[10px] rounded-full">
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
