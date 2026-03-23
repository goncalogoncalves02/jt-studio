import { Helmet } from "react-helmet-async";
import { servicesData } from "../data/servicesData";
import ServiceCard from "../components/ServiceCard";
import SEO from "../components/SEO";

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
        description: service.description,
        provider: {
          "@type": "BeautySalon",
          name: "JT Studio",
        },
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
    <div className="min-h-screen bg-gray-50 pb-20">
      <SEO
        title="Serviços"
        description="Serviços de Micropigmentação, Nanoblading, Soft Eyeliner, Tattoo e Remoção a Laser em Setúbal. Preços a partir de 10€. Agende no JT Studio."
      />
      <Helmet>
        <script type="application/ld+json">
          {JSON.stringify(servicesSchema)}
        </script>
      </Helmet>
      {/* Page Header */}
      <div className="bg-brand-dark text-white py-16 md:py-24 pb-8 text-center px-4">
        <h1 className="text-4xl md:text-5xl font-bold mb-4 mt-4">
          Serviços de Micropigmentação e Tattoo em Setúbal
        </h1>
        <p className="text-lg text-gray-300 max-w-2xl mx-auto">
          Conheça os serviços de micropigmentação, nanoblading, soft eyeliner, tattoo e remoção a laser disponíveis no JT Studio em Setúbal. Resultados naturais com segurança.
        </p>
      </div>

      {/* Services Grid */}
      <div className="container mx-auto px-4 mt-8 md:mt-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {servicesData.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default Services;
