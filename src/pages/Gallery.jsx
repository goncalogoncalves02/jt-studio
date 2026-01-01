import { useState } from "react";
import { galleryImages } from "../data/galleryData";
import Lightbox from "../components/Lightbox";
import { FaInstagram } from "react-icons/fa";
import SEO from "../components/SEO";

const Gallery = () => {
  const [selectedImage, setSelectedImage] = useState(null);

  return (
    <div className="min-h-screen bg-white pb-20">
      <SEO
        title="Galeria"
        description="Veja os resultados dos nossos procedimentos de Microblading e Estética. Fotos de antes e depois."
      />
      {/* Header */}
      <div className="bg-brand-dark text-white py-16 md:py-24 pb-8 text-center px-4">
        <h1 className="text-4xl md:text-5xl font-bold mb-4 mt-4">
          Galeria de Resultados
        </h1>
        <p className="text-gray-300 max-w-2xl mx-auto text-lg">
          Veja alguns dos nossos trabalhos e inspire-se.
        </p>
      </div>

      <div className="container mx-auto px-4 mt-12">
        {/* Mobile: Horizontal Scroll (Snap) */}
        {/* Desktop: Masonry-like Grid */}
        <div className="flex md:grid md:grid-cols-2 lg:grid-cols-3 gap-4 overflow-x-auto md:overflow-x-visible snap-x snap-mandatory pb-6 md:pb-0">
          {galleryImages.map((image) => (
            <div
              key={image.id}
              className="min-w-[80vw] md:min-w-0 snap-center cursor-pointer group relative overflow-hidden rounded-xl shadow-md hover:shadow-xl transition-all duration-300"
              onClick={() => setSelectedImage(image)}
            >
              <div className="aspect-3/4 md:aspect-auto">
                <img
                  src={image.src}
                  alt={image.alt}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                  loading="lazy"
                />
              </div>
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                <span className="text-white font-semibold bg-brand-pink/80 px-4 py-2 rounded-full">
                  Ver Zoom
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Instagram CTA */}
        <div className="mt-16 text-center">
          <a
            href="https://instagram.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-linear-to-r from-purple-500 via-brand-pink to-orange-400 text-white font-bold py-3 px-8 rounded-full shadow-lg hover:shadow-xl transform hover:-translate-y-1 transition-all duration-300"
          >
            <FaInstagram className="text-2xl" />
            Siga-nos no Instagram
          </a>
        </div>
      </div>

      {/* Lightbox Modal */}
      {selectedImage && (
        <Lightbox
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}
    </div>
  );
};

export default Gallery;
