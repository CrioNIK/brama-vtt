# Bezpečnost

[English](../../SECURITY.md) · [Українська](../uk/SECURITY.md) · [Español](../es/SECURITY.md) · [Polski](../pl/SECURITY.md) · [Čeština](SECURITY.md)

Toto je překlad [hlavního anglického dokumentu](../../SECURITY.md).

BRAMA je v současnosti určena pro místní použití. Naslouchá na rozhraní loopback, ukládá přihlašovací údaje relace v kartě prohlížeče a uchovává stav kampaně v SQLite. Aplikace není internetovou službou uživatelských účtů. Nezpřístupňujte vývojový server přímo veřejnému Internetu.

Server ověřuje příkazy a filtruje soukromá data pro každého účastníka. Vlastnictví tokenu, přístup k deníku postavy, přístup k deníku kampaně a příjemci prezentací jsou samostatná oprávnění. Klientské rozhraní není bezpečnostní hranicí. HTML se čistí; importované archivy jsou neaktivní data, nikoli spustitelná rozšíření.

Při podezření na zranitelnost použijte soukromé hlášení zranitelností na GitHubu, pokud je v tomto repozitáři dostupné. Jinak otevřete issue s žádostí o soukromý kontakt, aniž byste zveřejnili podrobnosti zneužití nebo soukromá data. Uveďte dotčené verze, minimální postup reprodukce se syntetickými daty, očekávané a skutečné chování a dopad. Nikdy nepřikládejte tokeny relací, kódy pozvánek, používané databáze ani materiály kampaně jiné osoby.

Tato raná verze nenabízí zaručenou dobu odpovědi ani období dlouhodobé podpory. Zálohujte místní data a před aktualizací si projděte změny.
