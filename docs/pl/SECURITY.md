# Bezpieczeństwo

[English](../../SECURITY.md) · [Українська](../uk/SECURITY.md) · [Español](../es/SECURITY.md) · [Polski](SECURITY.md) · [Čeština](../cs/SECURITY.md)

To tłumaczenie [nadrzędnego dokumentu angielskiego](../../SECURITY.md).

BRAMA jest obecnie przeznaczona do użytku lokalnego. Nasłuchuje na interfejsie loopback, przechowuje dane uwierzytelniające sesji w karcie przeglądarki i zapisuje stan kampanii w SQLite. Aplikacja nie jest internetową usługą kont użytkowników. Nie udostępniaj serwera deweloperskiego bezpośrednio w publicznym Internecie.

Serwer weryfikuje polecenia i filtruje prywatne dane dla każdego uczestnika. Własność żetonu, dostęp do karty postaci, dostęp do dziennika i odbiorcy prezentacji są odrębnymi uprawnieniami. Interfejs klienta nie stanowi granicy bezpieczeństwa. HTML jest oczyszczany; importowane archiwa to nieaktywne dane, a nie wykonywalne rozszerzenia.

W przypadku podejrzenia podatności użyj funkcji prywatnego zgłaszania podatności GitHub, jeśli jest dostępna w tym repozytorium. W przeciwnym razie otwórz zgłoszenie z prośbą o prywatny kontakt, bez publikowania szczegółów wykorzystania podatności ani prywatnych danych. Podaj dotknięte wersje, minimalny sposób odtworzenia z użyciem danych syntetycznych, oczekiwane i rzeczywiste zachowanie oraz skutki. Nigdy nie dołączaj tokenów sesji, kodów zaproszeń, używanych baz danych ani materiałów z cudzych kampanii.

Ta wczesna wersja nie oferuje gwarantowanego czasu odpowiedzi ani okresu długoterminowego wsparcia. Twórz kopie zapasowe lokalnych danych i przeglądaj zmiany przed aktualizacją.
