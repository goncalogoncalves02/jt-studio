import { Link } from "react-router-dom";
import {
  FaInstagram,
  FaWhatsapp,
  FaMapMarkerAlt,
  FaEnvelope,
} from "react-icons/fa";

const Footer = () => {
  return (
    <footer className="bg-brand-dark text-white pt-16 pb-8">
      <div className="container mx-auto px-4 grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
        {/* Brand */}
        <div>
          <Link
            to="/"
            className="text-3xl font-bold text-brand-pink tracking-wider"
          >
            JT<span className="text-white">Studio</span>
          </Link>
          <p className="mt-4 text-gray-400 leading-relaxed">
            Realçamos a sua beleza natural com técnicas avançadas e
            personalizadas. O seu rosto em boas mãos.
          </p>
        </div>

        {/* Quick Links */}
        <div>
          <h4 className="text-lg font-bold mb-6 text-brand-light-pink">
            Links Rápidos
          </h4>
          <ul className="space-y-3">
            <li>
              <Link
                to="/"
                className="text-gray-400 hover:text-brand-pink transition-colors"
              >
                Home
              </Link>
            </li>
            <li>
              <Link
                to="/servicos"
                className="text-gray-400 hover:text-brand-pink transition-colors"
              >
                Serviços
              </Link>
            </li>
            <li>
              <Link
                to="/galeria"
                className="text-gray-400 hover:text-brand-pink transition-colors"
              >
                Galeria
              </Link>
            </li>
            <li>
              <Link
                to="/info"
                className="text-gray-400 hover:text-brand-pink transition-colors"
              >
                Info & FAQ
              </Link>
            </li>
            <li>
              <Link
                to="/contactos"
                className="text-gray-400 hover:text-brand-pink transition-colors"
              >
                Contactos
              </Link>
            </li>
          </ul>
        </div>

        {/* Contacts */}
        <div>
          <h4 className="text-lg font-bold mb-6 text-brand-light-pink">
            Contactos
          </h4>
          <ul className="space-y-4">
            <li className="flex items-center gap-3">
              <FaWhatsapp className="text-brand-pink text-xl" />
              <a
                href="https://wa.me/351910000000"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white transition-colors"
              >
                +351 910 000 000
              </a>
            </li>
            <li className="flex items-center gap-3">
              <FaEnvelope className="text-brand-pink text-xl" />
              <a
                href="mailto:info@jtstudio.pt"
                className="text-gray-400 hover:text-white transition-colors"
              >
                info@jtstudio.pt
              </a>
            </li>
            <li className="flex items-start gap-3">
              <FaMapMarkerAlt className="text-brand-pink text-xl mt-1" />
              <span className="text-gray-400">
                Rua da Beleza, 123
                <br />
                1000-000 Lisboa, Portugal
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-gray-800 pt-8 text-center text-gray-500 text-sm">
        <p>
          &copy; {new Date().getFullYear()} JT Studio. Todos os direitos
          reservados.
        </p>
      </div>
    </footer>
  );
};

export default Footer;
