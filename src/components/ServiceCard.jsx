import { FiClock, FiTag } from "react-icons/fi";

const ServiceCard = ({ service }) => {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl border border-gray-100 transition-all duration-300 flex flex-col h-full transform hover:-translate-y-1">
      {/* Image Header */}
      <div className="h-64 overflow-hidden relative group bg-gray-50">
        <img
          src={service.imageUrl}
          alt={service.title}
          loading="lazy"
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
      </div>

      {/* Content */}
      <div className="p-6 flex flex-col grow">
        <h3 className="text-2xl font-bold text-brand-dark mb-2">
          {service.title}
        </h3>

        <p className="text-gray-600 mb-6 grow leading-relaxed">
          {service.description}
        </p>

        {/* Details: Price & Duration */}
        <div className="flex items-center justify-between mb-6 text-sm text-gray-500 border-t border-gray-100 pt-4">
          <div className="flex items-center gap-2">
            <FiClock className="text-brand-pink" />
            <span>{service.duration}</span>
          </div>
          <div className="flex items-center gap-2">
            <FiTag className="text-brand-pink" />
            <span className="font-semibold text-brand-dark">
              {service.price}
            </span>
          </div>
        </div>

        {/* Action Button */}
        <a
          href={service.bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full text-center bg-brand-dark text-white font-medium py-3 rounded-xl hover:bg-brand-pink transition-colors duration-300"
        >
          Agendar Este Serviço
        </a>
      </div>
    </div>
  );
};

export default ServiceCard;
