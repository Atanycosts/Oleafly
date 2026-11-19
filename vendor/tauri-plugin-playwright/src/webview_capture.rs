//! Capture the application's own WKWebView, without screen-recording access.
//! This is the webview Screenshot command; NativeScreenshot still captures the window.

use objc2::AnyThread;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Manager, Runtime};

pub async fn screenshot<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<Vec<u8>, String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("webview '{label}' not found"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let sender = std::cell::RefCell::new(Some(sender));
            let completion =
                block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = unsafe {
                        if let Some(error) = error.as_ref() {
                            Err(error.localizedDescription().to_string())
                        } else {
                            image
                                .as_ref()
                                .ok_or_else(|| "WebKit returned no snapshot image".to_string())
                                .and_then(|image| {
                                    image
                                        .TIFFRepresentation()
                                        .ok_or_else(|| "WebKit snapshot has no pixels".to_string())
                                })
                                .and_then(|data| {
                                    NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &data)
                                        .and_then(|bitmap| {
                                            bitmap.representationUsingType_properties(
                                                NSBitmapImageFileType::PNG,
                                                &NSDictionary::new(),
                                            )
                                        })
                                        .map(|png| png.to_vec())
                                        .ok_or_else(|| {
                                            "WebKit snapshot PNG encoding failed".to_string()
                                        })
                                })
                        }
                    };
                    if let Some(sender) = sender.borrow_mut().take() {
                        let _ = sender.send(result);
                    }
                });
            // Tauri runs this closure on the main thread with a live WKWebView.
            unsafe {
                let view = &*platform.inner().cast::<WKWebView>();
                view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "WebKit snapshot callback was dropped".to_string())?
}
