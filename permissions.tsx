import React from "react";
import ReactDOM from "react-dom/client";

const Permissions = () => {
  const requestPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((track) => track.stop());
      alert("Microphone permission granted!");
      window.close();
    } catch (error) {
      console.error("Error requesting permissions:", error);
      alert(
        "Failed to get microphone permission. Please allow it in your browser settings."
      );
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-lg font-bold mb-4">Microphone Permission</h1>
      <p className="mb-4">
        This extension needs access to your microphone to enable voice commands
        and live pair programming sessions.
      </p>
      <button
        onClick={requestPermissions}
        className="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded hover:bg-blue-700"
      >
        Grant Microphone Access
      </button>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Permissions />
  </React.StrictMode>
);
