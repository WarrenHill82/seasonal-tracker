import QtQuick
import QtQuick.Layouts
import QtWebEngine
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    Plasmoid.backgroundHints: PlasmaCore.Types.NoBackground
    preferredRepresentation: fullRepresentation
    switchWidth: Kirigami.Units.gridUnit * 14
    switchHeight: Kirigami.Units.gridUnit * 12

    fullRepresentation: Item {
        id: face

        Layout.minimumWidth: Kirigami.Units.gridUnit * 12
        Layout.minimumHeight: Kirigami.Units.gridUnit * 10
        Layout.preferredWidth: 720
        Layout.preferredHeight: 480
        Layout.fillWidth: true
        Layout.fillHeight: true

        readonly property string backendUrl: {
            const configured = plasmoid.configuration.backendUrl
            return (configured && configured.length) ? configured : "http://127.0.0.1:8765/"
        }

        WebEngineView {
            id: view
            anchors.fill: parent
            url: face.backendUrl
            backgroundColor: "transparent"

            onNavigationRequested: function(request) {
                const target = request.url.toString()
                if (target.startsWith("http://127.0.0.1") || target.startsWith("http://localhost")) {
                    request.accept()
                } else {
                    request.reject()
                    Qt.openUrlExternally(request.url)
                }
            }

            onLoadingChanged: function(request) {
                if (request.status === WebEngineView.LoadFailedStatus)
                    fail.visible = true
                else if (request.status === WebEngineView.LoadSucceededStatus)
                    fail.visible = false
            }
        }

        Rectangle {
            id: fail
            visible: false
            anchors.fill: parent
            color: "#0e1116"

            Column {
                anchors.centerIn: parent
                spacing: Kirigami.Units.smallSpacing
                width: parent.width - Kirigami.Units.gridUnit * 2

                Text {
                    width: parent.width
                    horizontalAlignment: Text.AlignHCenter
                    color: "#e8eef6"
                    font.pixelSize: 16
                    text: i18n("Tracker backend is not running")
                }
                Text {
                    width: parent.width
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                    color: "#8b98a8"
                    font.pixelSize: 12
                    text: i18n("From a terminal:\nsystemctl --user start seasonal-tracker.service\nthen click Retry.")
                }
                PlasmaComponents.Button {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: i18n("Retry")
                    onClicked: view.reload()
                }
            }
        }
    }

    compactRepresentation: Item {
        Kirigami.Icon {
            anchors.fill: parent
            source: "video-x-generic"
        }
        MouseArea {
            anchors.fill: parent
            onClicked: root.expanded = !root.expanded
        }
    }
}
