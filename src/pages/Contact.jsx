import {
  FaWhatsapp,
  FaEnvelope,
  FaPhoneAlt,
  FaMapMarkerAlt,
} from "react-icons/fa";
import SEO from "../components/SEO";

const Contact = () => {
  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <SEO
        title="Contactos"
        description="Entre em contacto connosco. Localização, email, telefone e agendamento online."
      />
      {/* Header */}
      <div className="bg-brand-dark text-white py-16 md:py-24 pb-8 text-center px-4">
        <h1 className="text-4xl md:text-5xl font-bold mb-4 mt-4">
          Contacte-nos
        </h1>
        <p className="text-gray-300 max-w-2xl mx-auto text-lg">
          Estamos à sua espera para transformar o seu olhar. Agende já a sua
          visita.
        </p>
      </div>

      <div className="container mx-auto px-4 mt-8 md:mt-12">
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col md:flex-row">
          {/* Info Side */}
          <div className="w-full md:w-1/2 p-8 md:p-12">
            <h2 className="text-2xl font-bold text-brand-dark mb-8">
              Informações de Contacto
            </h2>

            <div className="space-y-8">
              <div className="flex items-start gap-4">
                <div className="bg-brand-light-pink/30 p-3 rounded-full">
                  <FaWhatsapp className="text-2xl text-brand-pink" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">WhatsApp</h3>
                  <a
                    href="https://wa.me/351910000000"
                    className="text-gray-600 hover:text-brand-pink transition-colors"
                  >
                    +351 910 000 000
                  </a>
                  <p className="text-sm text-gray-500 mt-1">
                    Resposta rápida garantida.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-brand-light-pink/30 p-3 rounded-full">
                  <FaEnvelope className="text-2xl text-brand-pink" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">Email</h3>
                  <a
                    href="mailto:info@jtstudio.pt"
                    className="text-gray-600 hover:text-brand-pink transition-colors"
                  >
                    info@jtstudio.pt
                  </a>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-brand-light-pink/30 p-3 rounded-full">
                  <FaMapMarkerAlt className="text-2xl text-brand-pink" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">Morada</h3>
                  <p className="text-gray-600">
                    Rua da Beleza, 123
                    <br />
                    1000-000 Lisboa, Portugal
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-10">
              <a
                href="https://sumup.pt"
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full text-center bg-brand-dark text-white font-bold py-4 rounded-xl hover:bg-brand-pink transition-colors duration-300 shadow-lg"
              >
                Agendar Online (SumUp)
              </a>
            </div>
          </div>

          {/* Map Side */}
          <div className="w-full md:w-1/2 min-h-[400px] md:min-h-auto relative bg-gray-200">
            <iframe
              src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d1556.709971939103!2d-9.139!3d38.722!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0xd19337424b7a159%3A0x6280436c612660a1!2sLisboa!5e0!3m2!1spt-PT!2spt!4v1652798231268!5m2!1spt-PT!2spt"
              width="100%"
              height="100%"
              style={{ border: 0 }}
              allowFullScreen=""
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="absolute inset-0"
            ></iframe>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Contact;
