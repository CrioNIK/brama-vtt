# BRAMA VTT

**Wielojęzyczny wirtualny stół do gry autorstwa [CrioMant](https://github.com/CrioNIK).**

[English — oryginał](../../README.md) · [Українська](../uk/README.md) · [Español](../es/README.md) · [Polski](README.md) · [Čeština](../cs/README.md)

Tworzę BRAMĘ jako wspólną przestrzeń do opowiadania historii przy stole: mapę, postacie, kości, dzienniki i wyraźny podział między widokiem prowadzącego a widokiem każdego gracza. Aplikacja działa na Twoim komputerze i zapisuje stan kampanii w lokalnej bazie danych.

**Kod jest dostępny do użytku niekomercyjnego. Użytek komercyjny wymaga mojej uprzedniej pisemnej zgody.** Zobacz [licencję](LICENSE.md). To ograniczenie oznacza, że projekt nie jest udostępniany na licencji open source w rozumieniu OSI. Zależności zewnętrzne zachowują własne licencje wymienione w [informacjach o komponentach zewnętrznych](THIRD_PARTY_NOTICES.md).

## Dostępne możliwości

- Sceny z kwadratową siatką, poziomami, żetonami, ścianami, drzwiami, światłami, pomiarem i ograniczonym modelem widoczności.
- Oddzielne sesje prowadzącego i graczy, jawne uprawnienia oraz filtrowanie prywatnych informacji po stronie serwera.
- Karty postaci, ekwipunek, testy cech, rzuty obronne, umiejętności, zasoby, efekty i konfigurowalny rozwój.
- Koszty akcji, wyniki rzutów oraz jawne zastosowanie obrażeń lub leczenia jako osobne kroki.
- Kolejka walki z inicjatywą, rozstrzyganiem kolejności remisów, licznikami i przywracaniem poprzedniej tury.
- Dzienniki z formatowanym tekstem, obrazami, folderami, uprawnieniami dokumentów i stron, prywatnymi notatkami prowadzącego oraz pokazami dla wybranych odbiorców.
- Eksport kampanii do JSON, walidowany import dokumentów wymiany i trwałe potwierdzenia obsługiwanych poleceń.

Interfejs obsługuje **angielski, hiszpański, ukraiński, polski i czeski**. Początkowy język to ukraiński; przełącznik zapamiętuje wybór. Zmiana języka interfejsu nie tłumaczy ani nie zastępuje treści kampanii napisanej przez graczy. Oryginał dokumentacji jest angielski; pozostałe cztery wydania obejmują ten sam materiał.

## Uruchomienie lokalne

Zainstaluj **Node.js od 24.12 w ramach gałęzi 24.x**, a następnie wykonaj:

```sh
git clone https://github.com/CrioNIK/brama-vtt.git
cd brama-vtt
npm ci
npm run build
npm start
```

Otwórz **http://127.0.0.1:8015/**. Utwórz kampanię, a potem otwórz zaproszenie w innej karcie, aby dołączyć jako gracz. Prowadzący oddzielnie nadaje dostęp do żetonów i postaci. Dane sesji pozostają w danej karcie przeglądarki; zachowaj dostęp do karty prowadzącego.

Serwer celowo nasłuchuje tylko lokalnie. Zaproszenia działają na tym komputerze; hosting internetowy i odzyskiwanie kont nie są dostępne. `PORT` zmienia lokalny port, a `VTT_DB` — ścieżkę SQLite. Domyślna baza to `server/data/vtt.sqlite`.

## Gra i tworzenie materiałów

Narzędzia mapy umożliwiają wybieranie i przesuwanie obiektów, pomiar odległości oraz dodawanie żetonów, ścian, drzwi i świateł. Przed edycją wybierz scenę i poziom. Własność żetonu określa, kto nim steruje; uprawnienia karty — kto może przeglądać dane postaci.

Jawnie twórz akcje postaci i ich koszty zasobów. Sprawdź koszt przed wykonaniem akcji. Udana akcja może wygenerować rzut; zastosowanie obrażeń lub leczenia jest kolejną jawną operacją. Wyświetlenie wyniku kości samo w sobie nie zmienia punktów życia.

W walce dodaj uczestników, ustaw lub rzuć inicjatywę i rozpocznij starcie. Kolejka obsługuje pokonanych uczestników, remisy, liczniki i cofnięcie poprzedniego przejścia. Nie egzekwuje wszystkich zasad gry ani nie blokuje ruchu po mapie poza turą.

Dzienniki służą do materiałów i notatek. Strony mogą dziedziczyć dostęp dokumentu lub mieć własne uprawnienia. Pokaz dla wybranych osób wysyła zapisaną kopię stron bez przyznawania stałego dostępu do oryginału. Późniejsza edycja nie zmienia tej kopii. Archiwizacja dziennika odwołuje aktywne pokazy; przywrócenie nie wysyła ich ponownie.

Regularnie eksportuj kampanię. Eksport to przenośny dokument JSON; nie zastępuje działającej bazy ani nie gwarantuje przywracania kampanii jednym kliknięciem. Aby uzyskać spójną lokalną kopię zapasową, zatrzymaj serwer przed skopiowaniem bazy i powiązanych plików SQLite. Nie umieszczaj baz kampanii, eksportów, kodów zaproszeń ani danych sesji w publicznym repozytorium.

## Rozwój i weryfikacja

```sh
npm test
npm run typecheck
npm run build
```

Aby rozwijać klienta oddzielnie, uruchom `npm run dev` oraz `npm run client` w dwóch terminalach. Vite korzysta z portu 5173 i przekazuje API oraz WebSocket do portu 8015.

Projekt używa React, TypeScript, Vite, SQLite w Node, WebSocket, Tiptap i oczyszczania HTML. `client/` zawiera interfejs, `server/` — nadrzędne polecenia i zapis danych, `shared/` — kontrakty danych i pomocnicze reguły, a `tests/` — testy regresyjne i samodzielne dane testowe. Tłumaczenia używają angielskich kluczy i nazwanych parametrów; tekst graczy nie jest kluczem tłumaczenia.

Zmiany muszą zachować walidację poleceń, uprawnienia, atomowość zapisów i zachowanie ponowień. Brak potwierdzenia nie dowodzi niepowodzenia polecenia. Skorzystaj z odzyskiwania wyniku w interfejsie zamiast tworzyć nową operację, gdy wynik poprzedniej jest nieznany. Zobacz [Współtworzenie](CONTRIBUTING.md) i [Bezpieczeństwo](SECURITY.md).

## Obecne granice

BRAMA jest wczesną działającą aplikacją. Nie obejmuje pełnego systemu zasad, dowolnych skryptów, wspólnego scalania tekstu, pełnego cyklu importu i eksportu zewnętrznych dzienników, pinezek mapy, stron audio/wideo/PDF ani publicznego hostingu. Nieobsługiwane importowane reguły są zgłaszane lub odrzucane, a nie wykonywane po cichu. Model widoczności i edycja mobilna mają określone ograniczenia. Pozytywne testy potwierdzają sprawdzone kontrakty, nie uniwersalną zgodność ani każdy możliwy scenariusz gry.

## Autor i zgody

Autor i opiekun: **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. O zgodę komercyjną poproś przez formularz **Commercial permission** w repozytorium. Opisz zamierzony użytek, model dystrybucji i organizację. Otwarcie zgłoszenia nie jest zgodą; poczekaj na wyraźne pisemne porozumienie.

Copyright © 2026 CrioMant. Kod BRAMY i oryginalne zasoby podlegają [licencji](LICENSE.md). Informacje i licencje zależności nadal obowiązują dla odpowiednich komponentów.
