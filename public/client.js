console.log('Client-side code running');

const button = document.getElementById('sync');
button.addEventListener('click', function(e) {
  console.log('sync was clicked');
  button.classList = 'btn btn-outline-primary'
  button.disabled = true
  fetch('/sync', {method: 'POST'})
    .then(function(response) {
      if(response.ok) {
        console.log('Sync was finished');
        button.classList = 'btn btn-outline-success'
        setTimeout(function () {
            button.classList = "btn btn-outline-secondary"
            button.disabled = false
        }, 2000);
        //make green
        return;
      }
      throw new Error('Request failed.');
      //make red
    })
    .catch(function(error) {
      console.log(error);
    });
});