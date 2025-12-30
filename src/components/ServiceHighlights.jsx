import { Link } from "react-router-dom";
import { FaFeatherAlt, FaMagic, FaRegGem } from "react-icons/fa";

const ServiceHighlights = () => {
  const services = [
    {
      id: 1,
      title: "Microblading",
      description: "Sobrancelhas perfeitas e naturais com a técnica fio a fio.",
      icon: <FaFeatherAlt className="text-4xl text-brand-pink mb-4" />,
    },
    {
      id: 2,
      title: "Nanoblading",
      description:
        "Fios ainda mais finos e delicados para um realismo impressionante.",
      icon: <FaMagic className="text-4xl text-brand-pink mb-4" />,
    },
    {
      id: 3,
      title: "Estética Avançada",
      description:
        "Tratamentos faciais e corporais para rejuvenescer a sua pele.",
      icon: <FaRegGem className="text-4xl text-brand-pink mb-4" />,
    },
  ];

  return (
    <section className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-brand-dark mb-4">
            Os Nossos Serviços
          </h2>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Descubra os tratamentos mais procurados no JT Studio.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {services.map((service) => (
            <div
              key={service.id}
              className="bg-gray-50 p-8 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 border border-gray-100 flex flex-col items-center text-center"
            >
              {service.icon}
              <h3 className="text-xl font-bold text-brand-dark mb-3">
                {service.title}
              </h3>
              <p className="text-gray-600 mb-6 grow">{service.description}</p>
              <Link
                to="/servicos"
                className="text-brand-pink font-semibold hover:text-brand-dark transition-colors border-b-2 border-transparent hover:border-brand-pink"
              >
                Saber Mais
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ServiceHighlights;
