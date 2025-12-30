import { FiX } from "react-icons/fi";

const Lightbox = ({ image, onClose }) => {
  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white text-4xl focus:outline-none hover:text-brand-pink transition-colors"
        onClick={onClose}
      >
        <FiX />
      </button>
      <img
        src={image.src}
        alt={image.alt}
        className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()} // Prevent close when clicking image
      />
    </div>
  );
};

export default Lightbox;
