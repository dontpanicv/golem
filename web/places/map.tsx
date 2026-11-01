import L from "leaflet";
import { useEffect, useRef } from "react";

export interface Pin {
  readonly latitude: number;
  readonly longitude: number;
}

/** The zoom that shows a few streets around a pin. */
const STREETS = 15;

/**
 * An OpenStreetMap map, whose tiles come through Golem, with the place's pin in the middle and its circle: the map
 * moves under the pin, so a place always has one. Without a pin, it opens on the browser's location, when the person
 * allows it.
 */
export default function PlaceMap({
  pin,
  radius,
  onPin,
}: {
  pin: Pin | null;
  radius: number;
  onPin: (pin: Pin) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const circle = useRef<L.Circle | null>(null);
  const latestOnPin = useRef(onPin);
  latestOnPin.current = onPin;
  const start = useRef(pin);

  useEffect(() => {
    const opened = L.map(element.current!).setView(
      start.current
        ? [start.current.latitude, start.current.longitude]
        : [30, 0],
      start.current ? STREETS : 2
    );
    opened.attributionControl.setPrefix(false);
    L.tileLayer("/api/v1/map/{z}/{x}/{y}", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(opened);
    circle.current = L.circle(opened.getCenter(), {
      radius: 0,
      className: "place-circle",
      interactive: false,
    }).addTo(opened);
    const moved = () => {
      const center = opened.getCenter();
      circle.current?.setLatLng(center);
      latestOnPin.current({ latitude: center.lat, longitude: center.lng });
    };
    opened.on("move", moved);
    moved();
    if (!start.current) {
      navigator.geolocation?.getCurrentPosition(({ coords }) =>
        opened.setView([coords.latitude, coords.longitude], STREETS)
      );
    }
    return () => {
      opened.remove();
      circle.current = null;
    };
  }, []);

  useEffect(() => {
    circle.current?.setRadius(radius);
  }, [radius]);

  return (
    <div className="place-map">
      <div className="place-map-canvas" ref={element} />
      <span className="place-pin" />
    </div>
  );
}
