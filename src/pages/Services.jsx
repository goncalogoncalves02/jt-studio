import { servicesData } from "../data/servicesData";
import ServiceCard from "../components/ServiceCard";

const Services = () => {
  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Page Header */}
      <div className="bg-brand-dark text-white py-16 md:py-24 text-center px-4">
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          Os Nossos Serviços
        </h1>
        <p className="text-lg text-gray-300 max-w-2xl mx-auto">
          Conheça em detalhe os nossos procedimentos estéticos, desenhados para
          realçar a sua beleza com naturalidade e segurança.
        </p>
      </div>

      {/* Services Grid */}
      <div className="container mx-auto px-4 -mt-10">
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
