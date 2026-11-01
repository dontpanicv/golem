import L from "leaflet";
import { useEffect, useRef } from "react";

export interface Pin {
  readonly latitude: number;
  readonly longitude: number;
}

/** The zoom that shows a few streets around a pin. */
const STREETS = 15;

/**
 * An OpenStreetMap map, whose tiles come through Golem, with the place's pin and its circle. A click puts the pin, and
 * the pin drags. Without a pin, it opens on the browser's location, when the person allows it.
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
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
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
    opened.on("click", ({ latlng }) =>
      latestOnPin.current({ latitude: latlng.lat, longitude: latlng.lng })
    );
    if (!start.current) {
      navigator.geolocation?.getCurrentPosition(({ coords }) =>
        opened.setView([coords.latitude, coords.longitude], STREETS)
      );
    }
    map.current = opened;
    return () => {
      opened.remove();
      map.current = null;
      marker.current = null;
      circle.current = null;
    };
  }, []);

  useEffect(() => {
    const opened = map.current;
    if (!(opened && pin)) {
      return;
    }
    const at: L.LatLngTuple = [pin.latitude, pin.longitude];
    if (marker.current && circle.current) {
      marker.current.setLatLng(at);
      circle.current.setLatLng(at).setRadius(radius);
      return;
    }
    circle.current = L.circle(at, {
      radius,
      className: "place-circle",
      interactive: false,
    }).addTo(opened);
    marker.current = L.marker(at, {
      draggable: true,
      keyboard: false,
      icon: L.divIcon({ className: "place-pin", iconSize: [16, 16] }),
    })
      .on("drag", (event) =>
        circle.current?.setLatLng((event.target as L.Marker).getLatLng())
      )
      .on("dragend", (event) => {
        const { lat, lng } = (event.target as L.Marker).getLatLng();
        latestOnPin.current({ latitude: lat, longitude: lng });
      })
      .addTo(opened);
  }, [pin, radius]);

  return <div className="place-map" ref={element} />;
}
