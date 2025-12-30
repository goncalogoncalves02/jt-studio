import { useState } from "react";
import { Link } from "react-router-dom";
import { FiMenu, FiX } from "react-icons/fi";

const NavBar = () => {
  const [isOpen, setIsOpen] = useState(false);

  const navLinks = [
    { name: "Home", path: "/" },
    { name: "Serviços", path: "/servicos" },
    { name: "Info & FAQ", path: "/info" },
    { name: "Galeria", path: "/galeria" },
    { name: "Contactos", path: "/contactos" },
  ];

  return (
    <nav className="bg-brand-dark text-white shadow-md fixed w-full z-50">
      <div className="container mx-auto px-4 py-4 flex justify-between items-center">
        {/* Logo */}
        <Link
          to="/"
          className="text-2xl font-bold text-brand-pink tracking-wider"
        >
          JT<span className="text-white">Studio</span>
        </Link>

        {/* Desktop Menu */}
        <div className="hidden md:flex items-center space-x-8">
          {navLinks.map((link) => (
            <Link
              key={link.name}
              to={link.path}
              className="hover:text-brand-pink transition-colors duration-300 font-medium"
            >
              {link.name}
            </Link>
          ))}
          <button className="bg-brand-pink text-white px-6 py-2 rounded-full hover:bg-opacity-90 transition-all shadow-lg hover:shadow-brand-pink/20 font-semibold cursor-pointer">
            Marcar
          </button>
        </div>

        {/* Mobile Toggle */}
        <button
          className="md:hidden text-2xl text-brand-pink focus:outline-none"
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? <FiX /> : <FiMenu />}
        </button>
      </div>

      {/* Mobile Drawer */}
      {isOpen && (
        <div className="md:hidden absolute top-full left-0 w-full bg-brand-dark border-t border-gray-800 flex flex-col items-center py-6 space-y-6 animate-fade-in shadow-xl">
          {navLinks.map((link) => (
            <Link
              key={link.name}
              to={link.path}
              className="text-lg hover:text-brand-pink transition-colors"
              onClick={() => setIsOpen(false)}
            >
              {link.name}
            </Link>
          ))}
          <button className="bg-brand-pink text-white px-8 py-3 rounded-full hover:bg-opacity-90 transition-all font-semibold w-3/4">
            Marcar
          </button>
        </div>
      )}
    </nav>
  );
};

export default NavBar;
